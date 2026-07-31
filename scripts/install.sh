set -eu

release_tag="${YT2SHEET_RELEASE_TAG:-cli-v0.2.0}"
repository="${YT2SHEET_REPOSITORY:-qkrwndnjs1075/yt2sheet}"
base_url="${YT2SHEET_RELEASE_BASE_URL:-https://github.com/$repository/releases/download/$release_tag}"
base_url="${base_url%/}"

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

download "$base_url/$asset_name" "$archive_path"
download "$base_url/checksums.txt" "$checksums_path"

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

mkdir -p "$staging_root"
tar -xzf "$archive_path" -C "$staging_root"
install_root="${YT2SHEET_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/yt2sheet}"
bin_dir="${YT2SHEET_BIN_DIR:-$HOME/.local/bin}"
if [ -e "$install_root" ] || [ -L "$install_root" ]; then
  rm -rf "$install_root"
fi
mkdir -p "$install_root" "$bin_dir"
cp -R "$staging_root"/. "$install_root"/
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

printf 'yt2 설치 완료: %s\n' "$bin_dir/yt2"
printf '새 터미널에서 다음처럼 실행하세요: yt2 "https://www.youtube.com/watch?v=..."\n'
