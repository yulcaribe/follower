#!/usr/bin/env bash
set -Eeuo pipefail

REPO="yulcaribe/follower"
BIN="/opt/follower/follower"
DATA="/opt/follower/data"
UNIT="/etc/systemd/system/follower.service"
ENV_FILE="/etc/follower/follower.env"

say() { printf '%s\n' "$*"; }
die() { say "HATA: $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Follower kurulum / güncelleme (yalnızca Follower Go servisi)
Kullanım: curl -fsSL https://raw.githubusercontent.com/yulcaribe/follower/main/install.sh | bash
İsteğe bağlı: FOLLOWER_PORT=3102 bash install.sh
Veriler kurulum/güncelleme sırasında silinmez.
EOF
}

if [ "$#" -gt 0 ]; then
  case "$1" in --help|-h) usage; exit 0 ;; *) usage; exit 2 ;; esac
fi
[ "$(id -u)" -eq 0 ] || die "Root olarak çalıştır (sudo bash install.sh)."
[ -d /run/systemd/system ] || die "systemd ile çalışan bir Linux sunucu gerekli."
command -v apt-get >/dev/null 2>&1 || die "APT paket yöneticisi gerekli (Ubuntu/Debian)."
case "$(uname -m)" in x86_64|aarch64) ;; *) die "Yalnızca x86_64 ve ARM64 desteklenir." ;; esac

if ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates tar
fi

go_ok() {
  command -v go >/dev/null 2>&1 || return 1
  local v
  v="$(go version | sed -n 's/.* go\([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p')"
  [ -n "$v" ] && awk -F. -v v="$v" 'BEGIN { split(v, a, "."); exit !(a[1] > 1 || (a[1] == 1 && a[2] >= 23)) }'
}
if ! go_ok; then
  say "Go 1.23+ yükleniyor..."
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq golang-go
fi
go_ok || die "Go 1.23+ gerekli. Kurulu Go sürümünü kontrol et: go version"

WORK="$(mktemp -d /tmp/follower-install.XXXXXXXX)"
TRANSACTION=no
COMMITTED=no
PREV_RUNNING=no
PREV_ENABLED=no
restore_item() {
  local name="$1" target="$2"
  if [ -e "$WORK/backup/$name" ]; then
    cp -a -- "$WORK/backup/$name" "$target"
  else
    rm -f -- "$target"
  fi
}
cleanup() {
  local rc="$?"
  trap - EXIT
  if [ "$TRANSACTION" = yes ] && [ "$COMMITTED" = no ]; then
    say "Kurulum başarısız; önceki uygulama ve servis geri yükleniyor."
    systemctl stop follower >/dev/null 2>&1 || true
    restore_item bin "$BIN" || true
    restore_item unit "$UNIT" || true
    restore_item env "$ENV_FILE" || true
    systemctl daemon-reload || true
    if [ "$PREV_ENABLED" = yes ]; then
      systemctl enable follower >/dev/null 2>&1 || true
    else
      systemctl disable follower >/dev/null 2>&1 || true
    fi
    if [ "$PREV_RUNNING" = yes ]; then
      systemctl start follower >/dev/null 2>&1 || say "Eski servisi başlatmak mümkün olmadı, logları kontrol et."
    fi
    say "JSON verileri korunmuştur."
    [ "$rc" -ne 0 ] || rc=1
  fi
  rm -rf -- "$WORK"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

say "Follower GitHub main sürümü doğrulanıyor..."
curl --proto '=https' --proto-redir '=https' -fsSL --retry 3 --connect-timeout 15 --max-time 60 \
  "https://api.github.com/repos/$REPO/commits/main" -o "$WORK/commit.json"
COMMIT="$(awk -F'"' '/^[[:space:]]*"sha"[[:space:]]*:/ { print $4; exit }' "$WORK/commit.json")"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "GitHub commit bilgisi doğrulanamadı."
say "Kaynak indiriliyor: $COMMIT"
curl --proto '=https' --proto-redir '=https' -fsSL --retry 3 --connect-timeout 15 --max-time 180 \
  "https://codeload.github.com/$REPO/tar.gz/$COMMIT" -o "$WORK/source.tar.gz"
mkdir -p "$WORK/source"
tar -xzf "$WORK/source.tar.gz" -C "$WORK/source" --strip-components=1 --no-same-owner
grep -qx 'module github.com/yulcaribe/follower' "$WORK/source/go.mod" || die "Kaynak modül kimliği beklenenle eşleşmiyor."
[ -f "$WORK/source/deploy/follower.service" ] || die "systemd servis dosyası eksik."

say "Go testleri ve derleme..."
(
  cd "$WORK/source"
  GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off CGO_ENABLED=0 go test ./...
  GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off CGO_ENABLED=0 \
    go build -trimpath -ldflags='-s -w' -o "$WORK/candidate" .
)
[ -s "$WORK/candidate" ] || die "Derleme çıktısı bulunamadı."

# Önceki elle yapılmış kurulumu da tanı, başka servisleri asla üzerine yazma.
if [ -f "$UNIT" ] && ! grep -qF 'ExecStart=/opt/follower/follower' "$UNIT"; then
  die "follower.service farklı bir uygulamaya ait. Üzerine yazılmadı."
fi
PORT="$(printenv FOLLOWER_PORT 2>/dev/null || true)"
if [ -z "$PORT" ] && [ -f "$ENV_FILE" ]; then
  PORT="$(sed -n 's/^PORT=\([0-9]*\)$/\1/p' "$ENV_FILE" | head -n 1)"
fi
[ -n "$PORT" ] || PORT=3101
[[ "$PORT" =~ ^[0-9]{1,5}$ ]] || die "Geçersiz port: $PORT"
PORT="$((10#$PORT))"
[ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || die "Port 1024-65535 arasında olmalı."
if [ ! -f "$UNIT" ] && command -v ss >/dev/null 2>&1 &&
  ss -ltnH | awk -v p=":$PORT" '$4 ~ p"$" {found=1} END{exit !found}'; then
  die "$PORT portu dolu. FOLLOWER_PORT ile başka port belirt."
fi

id follower >/dev/null 2>&1 ||
  useradd --system --home /opt/follower --shell /usr/sbin/nologin follower
install -d -m 0755 /opt/follower
install -d -o follower -g follower -m 0700 "$DATA"
chown -R follower:follower "$DATA"

# Admin şifresi terminalde istenmez veya otomatik oluşturulmaz.
# İlk ziyaretinde kullanıcı yalnızca panelden şifresini belirler. Kurulum kodu yoktur.

mkdir -p "$WORK/backup" /etc/follower
if systemctl is-active --quiet follower 2>/dev/null; then PREV_RUNNING=yes; fi
if systemctl is-enabled --quiet follower 2>/dev/null; then PREV_ENABLED=yes; fi
[ ! -f "$BIN" ] || cp -a -- "$BIN" "$WORK/backup/bin"
[ ! -f "$UNIT" ] || cp -a -- "$UNIT" "$WORK/backup/unit"
[ ! -f "$ENV_FILE" ] || cp -a -- "$ENV_FILE" "$WORK/backup/env"

TRANSACTION=yes
if [ -f "$UNIT" ]; then systemctl stop follower; fi
install -o root -g root -m 0755 "$WORK/candidate" "$BIN"
install -o root -g root -m 0644 "$WORK/source/deploy/follower.service" "$UNIT"
printf 'PORT=%s\n' "$PORT" > "$WORK/config"
install -o root -g root -m 0600 "$WORK/config" "$ENV_FILE"
systemctl daemon-reload
systemctl enable follower >/dev/null
systemctl restart follower

say "Servis kontrol ediliyor..."
HEALTHY=no
for attempt in $(seq 1 30); do
  if systemctl is-active --quiet follower &&
    curl --noproxy '*' -fsS --connect-timeout 2 --max-time 3 \
      "http://127.0.0.1:$PORT/api/auth" 2>/dev/null | grep -q '"authenticated"'; then
    HEALTHY=yes
    break
  fi
  sleep 1
done
[ "$HEALTHY" = yes ] || die "Sağlık kontrolü başarısız (eski sürüm geri yüklenecek)."
COMMITTED=yes
say "Follower kuruldu/güncellendi ($COMMIT)."
say "Adres: http://SUNUCU_IP:$PORT"
if [ ! -s "$DATA/admin.json" ]; then
  say "İlk açılışta admin şifreni web panelinden oluştur. Kullanıcı adı ve kurulum kodu yoktur."
fi
say "Durum: systemctl status follower"
say "Loglar: journalctl -u follower -n 50 --no-pager"
say "UYARI: HTTP şifreli değildir. Eklenti anahtarı ve tarama verileri ağda korunmaz."
say "Chromium, Playwright, Node.js ve eski browser servislerine dokunulmadı."
