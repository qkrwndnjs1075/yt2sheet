set -eu

release_tag="${YT2SHEET_RELEASE_TAG:-cli-v0.2.0}"
repository="${YT2SHEET_REPOSITORY:-qkrwndnjs1075/yt2sheet}"
base_url="${YT2SHEET_RELEASE_BASE_URL:-https://github.com/$repository/releases/download/$release_tag}"
base_url="${base_url%/}"

total_steps=7
current_step=0
install_step() {
  current_step=$((current_step + 1))
  percent=$((current_step * 100 / total_steps))
  printf '### [%s/%s] %s (%s%%)\n' "$current_step" "$total_steps" "$1" "$percent"
}

os="$(uname -s)"
machine="$(uname -m)"
case "$os" in
  Darwin)
    case "$machine" in
      x86_64|amd64) target="darwin-x64" ;;
      arm64|aarch64) target="darwin-arm64" ;;
      *) printf '지원하지 않는 macOS CPU입니다: %s\n' "$machine" >&2; exit 1 ;;
    esac
    ;;
  Linux)
    case "$machine" in
      x86_64|amd64) target="linux-x64" ;;
      *) printf '현재 Linux는 x64만 지원합니다: %s\n' "$machine" >&2; exit 1 ;;
    esac
    ;;
  *)
    printf '지원하지 않는 운영체제입니다: %s\n' "$os" >&2
    exit 1
    ;;
esac

asset_name="yt2sheet-$target.tar.gz"
temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/yt2sheet-install.XXXXXX")"
archive_path="$temporary_root/$asset_name"
checksums_path="$temporary_root/checksums.txt"
staging_root="$temporary_root/staged"
cleanup() {
  rm -rf "$temporary_root"
}
trap cleanup EXIT

download() {
  url="$1"
  output="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$output"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$output"
  else
    printf 'curl 또는 wget이 필요합니다.\n' >&2
    exit 1
  fi
}

install_step "yt2 번들 다운로드 중"
download "$base_url/$asset_name" "$archive_path"
install_step "무결성 파일 다운로드 중"
download "$base_url/checksums.txt" "$checksums_path"

install_step "SHA-256 검증 중"
expected_hash="$(awk -v name="$asset_name" '$2 == name { print $1; exit }' "$checksums_path")"
case "$expected_hash" in
  [0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]*)
    ;;
  *)
    printf 'checksums.txt에서 %s 항목을 찾지 못했습니다.\n' "$asset_name" >&2
    exit 1
    ;;
esac

if command -v sha256sum >/dev/null 2>&1; then
  actual_hash="$(sha256sum "$archive_path" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  actual_hash="$(shasum -a 256 "$archive_path" | awk '{ print $1 }')"
else
  printf 'sha256sum 또는 shasum이 필요합니다.\n' >&2
  exit 1
fi
if [ "$expected_hash" != "$actual_hash" ]; then
  printf '다운로드한 파일의 SHA-256 검증에 실패했습니다.\n' >&2
  exit 1
fi

install_step "압축 해제 중"
mkdir -p "$staging_root"
tar -xzf "$archive_path" -C "$staging_root"
install_root="${YT2SHEET_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/yt2sheet}"
bin_dir="${YT2SHEET_BIN_DIR:-$HOME/.local/bin}"
install_step "파일 설치 중"
if [ -e "$install_root" ] || [ -L "$install_root" ]; then
  rm -rf "$install_root"
fi
mkdir -p "$install_root" "$bin_dir"
move_or_copy() {
  item="$1"
  if mv "$item" "$install_root/" 2>/dev/null; then
    return
  fi
  cp -R "$item" "$install_root/"
  rm -rf "$item"
}
for item in "$staging_root"/*; do
  [ -e "$item" ] || continue
  move_or_copy "$item"
done
install_step "PATH 등록 중"
ln -sfn "$install_root/bin/yt2" "$bin_dir/yt2"

case ":${PATH:-}:" in
  *":$bin_dir:"*)
    ;;
  *)
    profile="${YT2SHEET_PROFILE:-}"
    if [ -z "$profile" ]; then
      case "${SHELL:-}" in
        */zsh) profile="$HOME/.zprofile" ;;
        *) profile="$HOME/.profile" ;;
      esac
    fi
    path_line="export PATH=\"$bin_dir:\$PATH\""
    if [ ! -f "$profile" ] || ! grep -Fqx "$path_line" "$profile"; then
      printf '\n%s\n' "$path_line" >> "$profile"
    fi
    ;;
esac
export PATH="$bin_dir:${PATH:-}"

install_step "설치 파일 확인 중"
if [ ! -x "$install_root/bin/yt2" ]; then
  printf '설치된 yt2 실행 파일을 찾지 못했습니다: %s\n' "$install_root/bin/yt2" >&2
  exit 1
fi

printf 'yt2 설치 완료: %s\n' "$bin_dir/yt2"
printf '현재 셸에서 바로 실행: %s "https://www.youtube.com/watch?v=..."\n' "$bin_dir/yt2"
printf '도움말을 보려면 새 터미널에서 다음을 실행하세요: yt2 help\n'
printf '새 터미널에서 다음처럼 실행하세요: yt2 "https://www.youtube.com/watch?v=..."\n'
printf '삭제하려면: yt2 uninstall\n'
