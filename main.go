package main

import (
 "crypto/subtle"
 "embed"
 "encoding/csv"
 "encoding/json"
 "errors"
 "io"
 "log"
 "net"
 "net/http"
 "os"
 "path/filepath"
 "sort"
 "strings"
 "sync"
 "time"

 "github.com/yulcaribe/follower/internal/core"
 "github.com/yulcaribe/follower/internal/security"
)

//go:embed web/index.html web/app.js
var assets embed.FS

type attempt struct {Count int; Until time.Time}
type app struct {
 data string
 store core.Store
 sessions *security.Sessions
 mu sync.Mutex
 failures map[string]attempt
}
func newApp(data string)*app{
 return &app{data:data,store:core.Store{Root:data},sessions:security.NewSessions(),failures:map[string]attempt{}}
}
func reply(w http.ResponseWriter, status int, v any) {
 w.Header().Set("Content-Type","application/json; charset=utf-8")
 w.Header().Set("Cache-Control","no-store")
 w.WriteHeader(status)
 _=json.NewEncoder(w).Encode(v)
}
func bad(w http.ResponseWriter,n int,message string){reply(w,n,map[string]string{"error":message})}
func decode(w http.ResponseWriter,r *http.Request,dst any,max int64)error{
 if !strings.HasPrefix(r.Header.Get("Content-Type"),"application/json"){return errors.New("JSON gerekli")}
 d:=json.NewDecoder(http.MaxBytesReader(w,r.Body,max))
 d.DisallowUnknownFields()
 if err:=d.Decode(dst);err!=nil{return err}
 var tail any
 if err:=d.Decode(&tail);err!=io.EOF{return errors.New("Tek JSON nesnesi gerekli")}
 return nil
}
func (a *app) loggedIn(r *http.Request)bool{
 c,err:=r.Cookie("follower_admin")
 return err==nil&&a.sessions.Valid(c.Value)
}
func (a *app) session(w http.ResponseWriter)error{
 token,err:=a.sessions.New();if err!=nil{return err}
 http.SetCookie(w,&http.Cookie{Name:"follower_admin",Value:token,Path:"/",HttpOnly:true,SameSite:http.SameSiteStrictMode,MaxAge:43200})
 return nil
}
func (a *app) setup(w http.ResponseWriter,r *http.Request){
 var v struct{Password string `json:"password"`}
 if err:=decode(w,r,&v,4096);err!=nil{bad(w,400,"Geçersiz istek");return}
 a.mu.Lock();defer a.mu.Unlock()
 if err:=security.SetupPassword(a.data,v.Password);err!=nil{bad(w,400,err.Error());return}
 if err:=a.session(w);err!=nil{bad(w,500,"Oturum oluşturulamadı");return}
 reply(w,200,map[string]bool{"ok":true})
}
func (a *app) login(w http.ResponseWriter,r *http.Request){
 var v struct{Password string `json:"password"`}
 if err:=decode(w,r,&v,4096);err!=nil{bad(w,400,"Geçersiz istek");return}
 host,_,err:=net.SplitHostPort(r.RemoteAddr);if err!=nil{host=r.RemoteAddr}
 a.mu.Lock()
 p:=a.failures[host]
 locked:=p.Count>=6 && time.Now().Before(p.Until)
 a.mu.Unlock()
 if locked{bad(w,429,"Çok sayıda deneme. 10 dakika sonra tekrar dene");return}
 if !security.Verify(a.data,v.Password){
  a.mu.Lock()
  p=a.failures[host]
  if time.Now().After(p.Until){p.Count=0}
  p.Count++;p.Until=time.Now().Add(10*time.Minute);a.failures[host]=p
  a.mu.Unlock()
  bad(w,401,"Şifre yanlış");return
 }
 a.mu.Lock();delete(a.failures,host);a.mu.Unlock()
 if err:=a.session(w);err!=nil{bad(w,500,"Oturum oluşturulamadı");return}
 reply(w,200,map[string]bool{"ok":true})
}
func (a *app) changePassword(w http.ResponseWriter,r *http.Request){
 var v struct{OldPassword string `json:"oldPassword"`;NewPassword string `json:"newPassword"`}
 if err:=decode(w,r,&v,4096);err!=nil{bad(w,400,"Geçersiz istek");return}
 a.mu.Lock();defer a.mu.Unlock()
 if err:=security.ChangePassword(a.data,v.OldPassword,v.NewPassword);err!=nil{bad(w,400,err.Error());return}
 a.sessions.Clear()
 if err:=a.session(w);err!=nil{bad(w,500,"Oturum oluşturulamadı");return}
 reply(w,200,map[string]bool{"ok":true})
}
func (a *app) accounts()[]core.Account{
 files,_:=filepath.Glob(filepath.Join(a.data,"accounts","*","profile.json"))
 result:=[]core.Account{}
 for _,file:=range files{
  x,err:=core.ReadJSON[core.Account](file);if err==nil&&x.ID!=""{result=append(result,x)}
 }
 sort.Slice(result,func(i,j int)bool{return result[i].Username<result[j].Username})
 return result
}
func (a *app) state(w http.ResponseWriter,r *http.Request){
 id:=r.URL.Query().Get("id")
 accounts:=a.accounts()
 if id==""&&len(accounts)>0{id=accounts[0].ID}
 var snapshot *core.Snapshot;var report *core.Report;history:=[]core.HistoryRow{}
 if id!=""{
  var err error
  snapshot,report,history,err=a.store.Current(id)
  if err!=nil{bad(w,400,err.Error());return}
 }
 notBack:=[]core.User{}
 if snapshot!=nil{notBack=core.Subtract(snapshot.Following,snapshot.Followers)}
 reply(w,200,map[string]any{
  "accounts":accounts,"selectedId":id,"snapshot":snapshot,
  "report":report,"history":history,"notFollowingBack":notBack,
 })
}
func (a *app) ingest(w http.ResponseWriter,r *http.Request){
 var snap core.Snapshot
 if err:=decode(w,r,&snap,64<<20);err!=nil{bad(w,400,"Geçersiz veya fazla büyük tarama verisi: "+err.Error());return}
 if len(snap.Followers)>1000000||len(snap.Following)>1000000{
  bad(w,413,"Liste sınırı aşıldı");return
 }
 // Client timestamps are not trusted. Server time is canonical across devices.
 snap.TakenAt=time.Now().UTC()
 a.mu.Lock()
 defer a.mu.Unlock()
 if err:=a.store.Save(snap);err!=nil{bad(w,422,"Tarama kaydedilmedi: "+err.Error());return}
 reply(w,201,map[string]any{"ok":true,"id":snap.Account.ID,"takenAt":snap.TakenAt})
}
func safeCSV(s string)string{
 if s!=""&&strings.ContainsRune("=+-@",rune(s[0])){return "'"+s}
 return s
}
func (a *app) csv(w http.ResponseWriter,r *http.Request){
 id:=r.URL.Query().Get("id")
 snap,rep,_,err:=a.store.Current(id)
 if err!=nil||snap==nil{bad(w,404,"Kayıt yok");return}
 lists:=map[string][]core.User{
  "followers":snap.Followers,"following":snap.Following,
  "notFollowingBack":core.Subtract(snap.Following,snap.Followers),
 }
 if rep!=nil{
  lists["unfollowedYou"]=rep.UnfollowedYou;lists["newFollowers"]=rep.NewFollowers
  lists["youUnfollowed"]=rep.YouUnfollowed;lists["youStartedFollowing"]=rep.YouStartedFollowing
 }
 kind:=r.URL.Query().Get("kind")
 rows,ok:=lists[kind];if !ok{bad(w,400,"Geçersiz liste");return}
 w.Header().Set("Content-Type","text/csv; charset=utf-8")
 w.Header().Set("Content-Disposition","attachment; filename=follower-"+kind+".csv")
 cw:=csv.NewWriter(w)
 _=cw.Write([]string{"user_id","username","full_name"})
 for _,u:=range rows{_ =cw.Write([]string{safeCSV(u.ID),safeCSV(u.Username),safeCSV(u.FullName)})}
 cw.Flush()
}
func (a *app) ServeHTTP(w http.ResponseWriter,r *http.Request){
 w.Header().Set("X-Content-Type-Options","nosniff")
 w.Header().Set("Referrer-Policy","no-referrer")
 w.Header().Set("Cache-Control","no-store")
 w.Header().Set("X-Frame-Options","DENY")
 w.Header().Set("Content-Security-Policy","default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'")
 if r.Method=="GET"&&(r.URL.Path=="/"||r.URL.Path=="/app.js"){
  name:="web/index.html";typ:="text/html; charset=utf-8"
  if r.URL.Path=="/app.js"{name="web/app.js";typ="text/javascript; charset=utf-8"}
  b,err:=assets.ReadFile(name);if err!=nil{bad(w,500,"Arayüz okunamadı");return}
  w.Header().Set("Content-Type",typ);_,_ =w.Write(b);return
 }
 if r.Method=="GET"&&r.URL.Path=="/api/auth"{
  initialized,err:=security.Initialized(a.data)
  if err!=nil{bad(w,500,"Admin durumu okunamadı");return}
  reply(w,200,map[string]bool{"authenticated":initialized&&a.loggedIn(r),"setupRequired":!initialized});return
 }
 if !strings.HasPrefix(r.URL.Path,"/api/"){bad(w,404,"Yol bulunamadı");return}
 if r.Method=="POST"{
  if origin:=r.Header.Get("Origin");origin!=""{
   expected:="http://"+r.Host
   if subtle.ConstantTimeCompare([]byte(origin),[]byte(expected))!=1{
    bad(w,403,"Origin reddedildi");return
   }
  }
 }
 if r.Method=="POST"&&r.URL.Path=="/api/admin/setup"{a.setup(w,r);return}
 if r.Method=="POST"&&r.URL.Path=="/api/admin/login"{a.login(w,r);return}
 if !a.loggedIn(r){bad(w,401,"Admin şifresi gerekli");return}
 switch{
 case r.Method=="GET"&&r.URL.Path=="/api/state":a.state(w,r)
 case r.Method=="POST"&&r.URL.Path=="/api/scan":a.ingest(w,r)
 case r.Method=="GET"&&r.URL.Path=="/api/csv":a.csv(w,r)
 case r.Method=="POST"&&r.URL.Path=="/api/admin/change-password":a.changePassword(w,r)
 case r.Method=="POST"&&r.URL.Path=="/api/admin/logout":
  if cookie,err:=r.Cookie("follower_admin");err==nil{a.sessions.Delete(cookie.Value)}
  http.SetCookie(w,&http.Cookie{Name:"follower_admin",Path:"/",HttpOnly:true,SameSite:http.SameSiteStrictMode,MaxAge:-1})
  reply(w,200,map[string]bool{"ok":true})
 default:bad(w,404,"Yol bulunamadı")
 }
}
func migrateLegacy(a *app){
 files,_:=filepath.Glob(filepath.Join(a.data,"snapshots","*","*.json"))
 imported:=0
 for _,f:=range files{
  x,err:=core.ReadJSON[core.Snapshot](f);if err!=nil||x.Account.ID==""{continue}
  if err:=a.store.Save(x);err==nil{imported++}
 }
 if imported>0{log.Printf("Imported %d legacy snapshots",imported)}
}
func main(){
 data:=os.Getenv("DATA_DIR");if data==""{data="./data"}
 if err:=os.MkdirAll(data,0700);err!=nil{log.Fatal(err)}
 a:=newApp(data);migrateLegacy(a)
 port:=os.Getenv("PORT");if port==""{port="3101"}
 host:=os.Getenv("HOST");if host==""{host="0.0.0.0"}
 srv:=&http.Server{
  Addr:net.JoinHostPort(host,port),Handler:a,
  ReadHeaderTimeout:10*time.Second,ReadTimeout:75*time.Second,
  WriteTimeout:75*time.Second,IdleTimeout:60*time.Second,MaxHeaderBytes:16<<10,
 }
 log.Printf("Follower server %s (extension scan mode, JSON storage)",srv.Addr)
 log.Fatal(srv.ListenAndServe())
}
