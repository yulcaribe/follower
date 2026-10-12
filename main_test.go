package main

import (
  "os"
  "encoding/json"
  "net/http"
  "net/http/httptest"
  "github.com/yulcaribe/follower/internal/core"
  "os/exec"
  "path/filepath"
  "strings"
  "testing"

  "github.com/yulcaribe/follower/internal/security"
)


func TestWebAdminSetupAndChangePassword(t *testing.T) {
	dir := t.TempDir()
	if _, err := os.Stat(filepath.Join(dir,"admin.json")); !os.IsNotExist(err) { t.Fatal("admin should not exist before setup") }
	if _, err := os.Stat(filepath.Join(dir,"setup-code")); !os.IsNotExist(err) { t.Fatal("setup code must not be generated") }
	a := newApp(dir)
	getAuth := func(cookie *http.Cookie) map[string]bool {
		request := httptest.NewRequest("GET", "/api/auth", nil)
		if cookie != nil { request.AddCookie(cookie) }
		response := httptest.NewRecorder()
		a.ServeHTTP(response, request)
		if response.Code != 200 { t.Fatalf("auth status %d: %s", response.Code, response.Body.String()) }
		var out map[string]bool
		if err := json.Unmarshal(response.Body.Bytes(), &out); err != nil { t.Fatal(err) }
		return out
	}
	post := func(path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
		request := httptest.NewRequest("POST", path, strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		if cookie != nil { request.AddCookie(cookie) }
		response := httptest.NewRecorder()
		a.ServeHTTP(response, request)
		return response
	}
	if !getAuth(nil)["setupRequired"] { t.Fatal("expected initial setup") }
	if result := post("/api/admin/setup", `{"password":""}`, nil); result.Code == 200 { t.Fatal("empty setup password accepted") }
	response := post("/api/admin/setup", `{"password":"1"}`, nil)
	if response.Code != 200 { t.Fatalf("setup failed %d: %s", response.Code, response.Body.String()) }
	cookie := response.Result().Cookies()[0]
	if !getAuth(cookie)["authenticated"] || getAuth(nil)["setupRequired"] { t.Fatal("setup not completed") }
	if !security.Verify(dir, "1") { t.Fatal("single character password rejected") }
	if _, err := os.Stat(filepath.Join(dir,"setup-code")); !os.IsNotExist(err) { t.Fatal("setup code must be removed") }
	if result := post("/api/admin/setup", `{"password":"3"}`, nil); result.Code == 200 { t.Fatal("setup unexpectedly reran") }
	if result := post("/api/admin/setup", `{"code":"abc","password":"3"}`, nil); result.Code == 200 { t.Fatal("obsolete code setup unexpectedly accepted") }
	if result := post("/api/admin/change-password", `{"oldPassword":"wrong","newPassword":"2"}`, cookie); result.Code == 200 { t.Fatal("wrong old password accepted") }
	response = post("/api/admin/change-password", `{"oldPassword":"1","newPassword":"2"}`, cookie)
	if response.Code != 200 { t.Fatalf("change failed %d: %s", response.Code, response.Body.String()) }
	newCookie := response.Result().Cookies()[0]
	if !security.Verify(dir, "2") || security.Verify(dir, "1") { t.Fatal("password was not changed") }
	if getAuth(cookie)["authenticated"] || !getAuth(newCookie)["authenticated"] { t.Fatal("admin sessions not rotated") }
}

func TestInstallerScriptsSyntaxAndHelp(t *testing.T) {
  if _, err := exec.LookPath("bash"); err != nil { t.Skip("bash not available") }
  for _, name := range []string{"install.sh", "uninstall.sh"} {
    t.Run(name, func(t *testing.T) {
      if out, err := exec.Command("bash", "-n", name).CombinedOutput(); err != nil {
        t.Fatalf("bash syntax: %v\n%s", err, out)
      }
      script, err := os.Open(name)
      if err != nil { t.Fatal(err) }
      defer script.Close()
      cmd := exec.Command("bash", "-s", "--", "--help")
      cmd.Stdin = script
      out, err := cmd.CombinedOutput()
      if err != nil || !strings.Contains(string(out), "Follower") {
        t.Fatalf("stdin installer --help: %v\n%s", err, out)
      }
    })
  }
}

func TestMultipleAccountsCentralHistoryAdminOnly(t *testing.T) {
 dir:=t.TempDir()
 if err:=security.InitPassword(dir,"1");err!=nil{t.Fatal(err)}
 a:=newApp(dir)
 post:=func(path,body string,cookie *http.Cookie,origin string)*httptest.ResponseRecorder{
  req:=httptest.NewRequest("POST",path,strings.NewReader(body))
  req.Header.Set("Content-Type","application/json")
  if cookie!=nil{req.AddCookie(cookie)}
  if origin!=""{req.Header.Set("Origin",origin)}
  w:=httptest.NewRecorder();a.ServeHTTP(w,req);return w
 }
 get:=func(path string,cookie *http.Cookie)*httptest.ResponseRecorder{
  req:=httptest.NewRequest("GET",path,nil)
  if cookie!=nil{req.AddCookie(cookie)}
  w:=httptest.NewRecorder();a.ServeHTTP(w,req);return w
 }
 login:=post("/api/admin/login",`{"password":"1"}`,nil,"")
 if login.Code!=200{t.Fatalf("login: %s",login.Body.String())}
 cookie:=login.Result().Cookies()[0]
 if res:=get("/api/state",nil);res.Code!=401{t.Fatal("unprotected state read")}
 if res:=get("/api/sync/state",cookie);res.Code!=404{t.Fatal("old sync route remains")}
 if res:=post("/api/scan",`{}`,nil,"");res.Code!=401{t.Fatal("anonymous scan accepted")}
 save:=func(id,name string,n int){
  t.Helper()
  snap:=core.Snapshot{Account:core.Account{ID:id,Username:name},ProfileCounts:&core.Counts{Followers:1,Following:1},
   Followers:[]core.User{{ID:"31",Username:"ali"}},
   Following:[]core.User{{ID:"32",Username:"veli"}}}
  b,e:=json.Marshal(snap);if e!=nil{t.Fatal(e)}
  if res:=post("/api/scan",string(b),cookie,"http://attacker.test");res.Code!=403{t.Fatal("foreign origin accepted")}
  res:=post("/api/scan",string(b),cookie,"http://example.com")
  if res.Code!=201{t.Fatalf("save %s: %d %s",id,res.Code,res.Body.String())}
 }
 save("123456","first_account",1)
 save("987654","second_account",1)
 for _,id:=range []string{"123456","987654"}{
  res:=get("/api/state?id="+id,cookie)
  if res.Code!=200||!strings.Contains(res.Body.String(),id){t.Fatalf("missing account %s",id)}
  files,err:=filepath.Glob(filepath.Join(dir,"accounts",id,"snapshots","*.json"))
  if err!=nil||len(files)!=1{t.Fatalf("account isolation %s %v %v",id,files,err)}
 }
 res:=get("/api/state",cookie)
 if !strings.Contains(res.Body.String(),"first_account")||!strings.Contains(res.Body.String(),"second_account"){
  t.Fatal("multi account selector missing accounts")
 }
 save("123456","renamed_account",2)
 p,err:=core.ReadJSON[core.Account](filepath.Join(dir,"accounts","123456","profile.json"))
 if err!=nil||p.Username!="renamed_account"{t.Fatal("username change did not update label")}
 files,_:=filepath.Glob(filepath.Join(dir,"accounts","123456","snapshots","*.json"))
 if len(files)!=2{t.Fatalf("previous history was lost on username change: %d",len(files))}
 incomplete:=core.Snapshot{Account:core.Account{ID:"987654",Username:"second_account"},
  ProfileCounts:&core.Counts{Followers:100,Following:1},
  Followers:[]core.User{},Following:[]core.User{{ID:"32",Username:"veli"}}}
 b,_:=json.Marshal(incomplete)
 if res:=post("/api/scan",string(b),cookie,"");res.Code!=422{t.Fatalf("incomplete accepted: %d",res.Code)}
 files,_=filepath.Glob(filepath.Join(dir,"accounts","987654","snapshots","*.json"))
 if len(files)!=1{t.Fatal("incomplete scan overwrote history")}
}
func TestOldBrowserRoutesAbsent(t *testing.T){
 dir:=t.TempDir()
 a:=newApp(dir)
 for _,path:=range []string{"/api/browser/status","/api/browser/open","/api/instagram/login","/api/scan"}{
  req:=httptest.NewRequest("GET",path,nil);rec:=httptest.NewRecorder()
  a.ServeHTTP(rec,req)
  if rec.Code!=401 && rec.Code!=404{t.Fatalf("unexpected browser route %s: %d",path,rec.Code)}
 }
}
