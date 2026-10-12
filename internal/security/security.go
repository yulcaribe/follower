package security

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"github.com/yulcaribe/follower/internal/core"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const iterations = 180000

type HashFile struct {
	Salt       string `json:"salt"`
	Hash       string `json:"hash"`
	Iterations int    `json:"iterations"`
}

func key(password string, salt []byte, rounds int) []byte {
	mac := hmac.New(sha256.New, []byte(password))
	_, _ = mac.Write(salt)
	_, _ = mac.Write([]byte{0, 0, 0, 1})
	u := mac.Sum(nil)
	out := append([]byte(nil), u...)
	for i := 1; i < rounds; i++ {
		mac = hmac.New(sha256.New, []byte(password))
		_, _ = mac.Write(u)
		u = mac.Sum(nil)
		for j := range out {
			out[j] ^= u[j]
		}
	}
	return out
}
func InitPassword(data, password string) error {
	file := filepath.Join(data, "admin.json")
	if _, err := os.Stat(file); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if len(password) < 1 {
		return errors.New("admin şifresi boş olamaz")
	}
	salt := make([]byte, 24)
	if _, err := rand.Read(salt); err != nil {
		return err
	}
	hash := key(password, salt, iterations)
	return core.WriteJSON(file, HashFile{base64.StdEncoding.EncodeToString(salt), base64.StdEncoding.EncodeToString(hash), iterations})
}

func Initialized(data string) (bool, error) {
 _, err := os.Stat(filepath.Join(data, "admin.json"))
 if err == nil { return true, nil }
 if errors.Is(err, os.ErrNotExist) { return false, nil }
 return false, err
}

// Called only after the user submits a password in the first-run web panel.
// Admin setup is serialized by app.mu in the HTTP handler.
func SetupPassword(data, password string) error {
 if len(password)==0 { return errors.New("admin şifresi boş olamaz") }
 if len(password)>1024 { return errors.New("şifre çok uzun") }
 installed,err:=Initialized(data)
 if err!=nil{return err}
 if installed {return errors.New("admin zaten oluşturulmuş")}
 return InitPassword(data,password)
}

func ChangePassword(data, oldPassword, newPassword string) error {
	if len(newPassword) == 0 { return errors.New("yeni şifre boş olamaz") }
	if len(newPassword) > 1024 { return errors.New("şifre çok uzun") }
	if !Verify(data, oldPassword) { return errors.New("mevcut admin şifresi yanlış") }
	salt := make([]byte, 24)
	if _, err := rand.Read(salt); err != nil { return err }
	hash := key(newPassword, salt, iterations)
	return core.WriteJSON(filepath.Join(data, "admin.json"), HashFile{
		Salt: base64.StdEncoding.EncodeToString(salt),
		Hash: base64.StdEncoding.EncodeToString(hash), Iterations: iterations,
	})
}

func Verify(data, password string) bool {
	f, err := core.ReadJSON[HashFile](filepath.Join(data, "admin.json"))
	if err != nil {
		return false
	}
	salt, err := base64.StdEncoding.DecodeString(f.Salt)
	if err != nil {
		return false
	}
	hash, err := base64.StdEncoding.DecodeString(f.Hash)
	if err != nil {
		return false
	}
	if f.Iterations < 100000 || f.Iterations > 1000000 || len(hash) != 32 {
		return false
	}
	actual := key(password, salt, f.Iterations)
	return subtle.ConstantTimeCompare(hash, actual) == 1
}

type Sessions struct {
	mu     sync.Mutex
	tokens map[string]time.Time
}

func NewSessions() *Sessions { return &Sessions{tokens: make(map[string]time.Time)} }
func (s *Sessions) New() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	t := base64.RawURLEncoding.EncodeToString(b)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tokens[t] = time.Now().Add(12 * time.Hour)
	return t, nil
}
func (s *Sessions) Valid(t string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	exp, ok := s.tokens[t]
	if !ok {
		return false
	}
	if time.Now().After(exp) {
		delete(s.tokens, t)
		return false
	}
	return true
}
func (s *Sessions) Delete(t string) { s.mu.Lock(); defer s.mu.Unlock(); delete(s.tokens, t) }
func (s *Sessions) Count() int      { s.mu.Lock(); defer s.mu.Unlock(); return len(s.tokens) }


func (s *Sessions) Clear() { s.mu.Lock(); defer s.mu.Unlock(); s.tokens = make(map[string]time.Time) }
