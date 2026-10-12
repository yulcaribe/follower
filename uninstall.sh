#!/usr/bin/env bash
set -Eeuo pipefail

BIN="/opt/follower/follower"
DATA="/opt/follower/data"
UNIT="/etc/systemd/system/follower.service"
ENV_FILE="/etc/follower/follower.env"
usage() {
  cat <<'EOF'
Follower Go servisini kaldırma, tarayıcı bileşenlerine dokunmaz
Kullanım: curl -fsSL https://raw.githubusercontent.com/yulcaribe/follower/main/uninstall.sh | bash
Varsayılan: Uygulamayı ve servisi kaldırır, JSON verilerini SAKLAR.
Veriyi de silmek için: bash uninstall.sh --purge-data (etkileşimli onay gerekir).
EOF
}
PURGE=no
case "$#" in
  0) ;;
  1) case "$1" in --help|-h) usage; exit 0 ;; --purge-data) PURGE=yes ;; *) usage; exit 2 ;; esac ;;
  *) usage; exit 2 ;;
esac
[ "$(id -u)" -eq 0 ] || { echo "Root gerekli." >&2; exit 1; }
if [ -f "$UNIT" ] && ! grep -qF 'ExecStart=/opt/follower/follower' "$UNIT"; then
  echo "Servis farklı uygulamaya ait; kaldırılmadı." >&2
  exit 1
fi
if [ "$PURGE" = yes ]; then
  [ -r /dev/tty ] || { echo "Veri silme onayı için terminal gerekli." >&2; exit 1; }
  echo "DİKKAT: $DATA ve tüm JSON geçmişi KALICI olarak silinecek." >/dev/tty
  read -r -p 'Onay için SIL yaz: ' ANSWER </dev/tty
  [ "$ANSWER" = SIL ] || { echo "İptal edildi."; exit 1; }
fi
systemctl disable --now follower >/dev/null 2>&1 || true
rm -f -- "$UNIT" "$BIN" "$ENV_FILE"
systemctl daemon-reload
if [ "$PURGE" = yes ]; then
  rm -rf -- "$DATA"
  echo "Follower ve JSON verileri silindi."
else
  echo "Follower kaldırıldı. JSON geçmişi korundu: $DATA"
fi
echo "Chromium, Playwright, Node.js ve eski browser servisine dokunulmadı."
echo "Diğer uygulamalara, Docker'a, firewall'a ve kaynak klonlarına dokunulmadı."
