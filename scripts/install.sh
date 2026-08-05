#!/bin/sh
set -eu

release_tag="${YT2SHEET_RELEASE_TAG:-cli-v0.2.13}"
repository="${YT2SHEET_REPOSITORY:-qkrwndnjs1075/yt2sheet}"
if [ -n "${YT2SHEET_RELEASE_BASE_URL:-}" ]; then
  base_url="$YT2SHEET_RELEASE_BASE_URL"
else
  base_url="https://github.com/$repository/releases/download/$release_tag"
fi
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
      x86_64|amd64) ;;
      *) printf '현재 Linux는 x64만 지원합니다: %s\n' "$machine" >&2; exit 1 ;;
    esac
    os_release_file="${YT2SHEET_OS_RELEASE_FILE:-/etc/os-release}"
    if [ ! -f "$os_release_file" ]; then
      printf '지원하는 Ubuntu 버전을 확인할 수 없습니다: %s\n' "$os_release_file" >&2
      exit 1
    fi
    linux_id="$(sed -n 's/^ID=//p' "$os_release_file" | head -n 1 | tr -d "\"'")"
    linux_version="$(sed -n 's/^VERSION_ID=//p' "$os_release_file" | head -n 1 | tr -d "\"'")"
    if [ "$linux_id" != "ubuntu" ]; then
      printf '지원하지 않는 Linux 배포판입니다: %s (Ubuntu 22.04/24.04 x64만 지원)\n' "${linux_id:-unknown}" >&2
      exit 1
    fi
    case "$linux_version" in
      22.04|24.04) target="linux-x64" ;;
      *) printf '지원하지 않는 Ubuntu 버전입니다: %s (22.04/24.04 x64만 지원)\n' "${linux_version:-unknown}" >&2; exit 1 ;;
    esac
    ;;
  *)
    printf '지원하지 않는 운영체제입니다: %s\n' "$os" >&2
    exit 1
    ;;
esac

asset_name="yt2sheet-$target.tar.gz"
install_root="${YT2SHEET_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/yt2sheet}"
bin_dir="${YT2SHEET_BIN_DIR:-$HOME/.local/bin}"
install_parent="$(dirname "$install_root")"
mkdir -p "$install_parent"
temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/yt2sheet-install.XXXXXX")"
archive_path="$temporary_root/$asset_name"
checksums_path="$temporary_root/checksums.txt"
staging_root="$(mktemp -d "$install_parent/.yt2sheet-installing.XXXXXX")"
backup_container="$(mktemp -d "$install_parent/.yt2sheet-backup.XXXXXX")"
backup_root="$backup_container/previous"
swapped=0
installed=0
cleanup() {
  if [ "$installed" -eq 0 ] && [ "$swapped" -eq 1 ]; then
    rm -rf "$install_root"
    if [ -e "$backup_root" ]; then
      mv "$backup_root" "$install_root"
    fi
  fi
  rm -rf "$staging_root" "$backup_container"
  rm -rf "$temporary_root"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

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
expected_hash="$(awk -v name="$asset_name" '$2 == name || $2 == "release-assets/" name { print $1; exit }' "$checksums_path")"
if ! printf '%s\n' "$expected_hash" | grep -Eq '^[0-9a-fA-F]{64}$'; then
  printf 'checksums.txt에서 %s 항목을 찾지 못했습니다.\n' "$asset_name" >&2
  exit 1
fi

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

archive_bytes="$(wc -c < "$archive_path" | tr -d ' ')"
available_kb="$(df -Pk "$install_parent" | awk 'NR == 2 { print $4; exit }')"
required_bytes=$((archive_bytes * 4))
case "$available_kb" in
  ''|*[!0-9]*) printf '설치 디스크 용량을 확인하지 못했습니다.\n' >&2; exit 1 ;;
esac
if [ $((available_kb * 1024)) -lt "$required_bytes" ]; then
  printf '설치 디스크 용량이 부족합니다. 필요: %s bytes\n' "$required_bytes" >&2
  exit 1
fi

install_step "압축 해제 중"
if tar -tzf "$archive_path" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  printf '안전하지 않은 아카이브 경로를 거부했습니다.\n' >&2
  exit 1
fi
tar -xzf "$archive_path" -C "$staging_root"
for required_path in runtime/bin/node app/dist-cli/cli/index.js bin/yt2 tools/yt-dlp tools/audiveris tools/musescore tools/score-runtime-inventory.json THIRD_PARTY VERSION THIRD_PARTY_NOTICES.md bom.cdx.json SOURCE_MANIFEST.json COMPLIANCE_SUMMARY.json; do
  if [ ! -e "$staging_root/$required_path" ]; then
    printf '완전하지 않은 yt2 번들입니다: %s\n' "$required_path" >&2
    exit 1
  fi
done
runtime_node="$staging_root/runtime/bin/node"
if [ ! -x "$runtime_node" ]; then
  printf '번들 Node 런타임을 실행할 수 없습니다.\n' >&2
  exit 1
fi
# The validator is literal JavaScript; shell expansion would corrupt template expressions.
# shellcheck disable=SC2016
validation_output="$("$runtime_node" -e '
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),child=require("node:child_process");
const [root,target]=process.argv.slice(1), fail=(message)=>{throw new Error(`invalid yt2sheet bundle: ${message}`)};
const read=(name)=>fs.readFileSync(path.join(root,name)), json=(name)=>{try{return JSON.parse(read(name))}catch{return fail(`${name} is not valid JSON`)}};
const hash=(value)=>crypto.createHash("sha256").update(value).digest("hex"), safe=(name)=>{if(typeof name!=="string"||name.startsWith("/")||name.includes("\\")||name.split("/").includes(".."))fail(`unsafe inventory path ${name}`);return path.join(root,...name.split("/"))};
const contracts={
  "darwin-arm64":["macos-14-arm64","17491af8b6d40153b031dd1f0815e37213f0999ef23f10586af46706e59b2eb6","e3596e27da0806a3384cab67d52f8478ad21ed2bd6fc96d7cb874d840b016fac"],
  "darwin-x64":["macos-14-x64","11794424c6f1698617836a77d2c5818c46405a3fe7388281c623c4e383fa33cb","e3596e27da0806a3384cab67d52f8478ad21ed2bd6fc96d7cb874d840b016fac"],
  "linux-x64":["ubuntu-22.04-x64","ae714594f40e54b1a4951fc3f914f08ae38fe5d07b7f2283b1a904fdb6e0a318","9233ed1b87d3e6b45722278f3c286dcd41e83da778bd0f80a1dd04949696ad93"]
};
const contract=contracts[target]; if(!contract)fail(`unsupported target ${target}`);
if(!new RegExp(`^yt2sheet \\d+\\.\\d+\\.\\d+ ${target}\\n?$`).test(read("VERSION").toString("utf8")))fail("VERSION does not match the release target");
const inventory=json("tools/score-runtime-inventory.json");
if(inventory.schemaVersion!=="score-runtime-inventory/1"||inventory.platformId!==contract[0]||!Array.isArray(inventory.entries)||inventory.entries.length===0)fail("runtime inventory contract mismatch");
for(const [tool,version,digest] of [["audiveris","5.11.0",contract[1]],["musescore","4.7.4",contract[2]]]){
  const archive=inventory.archives?.[tool]; if(!archive||archive.sha256!==digest||inventory.versionProbes?.[tool]!==version||typeof archive.stagedExecutable!=="string"||!archive.stagedExecutable.startsWith(`tools/${tool}/`))fail(`${tool} manifest mismatch`);
  const executable=safe(archive.stagedExecutable); try{fs.accessSync(executable,fs.constants.X_OK)}catch{fail(`${tool} executable is unavailable`)}
  const probe=child.spawnSync(executable,["--version"],{encoding:"utf8",timeout:120000}); const outputs=[probe.stdout,probe.stderr].map((value)=>String(value??"").replace(/\r\n?/g,"\n").trim()).filter(Boolean);
  if(probe.status!==0||outputs.length!==1||outputs[0]!==version)fail(`${tool} version probe mismatch`);
}
for(const entry of inventory.entries){const item=safe(entry.path);let stats;try{stats=fs.lstatSync(item)}catch{fail(`inventory path missing: ${entry.path}`)}if(entry.type==="file"){if(!stats.isFile()||hash(read(entry.path))!==entry.sha256)fail(`inventory file mismatch: ${entry.path}`)}else if(entry.type==="symlink"){if(!stats.isSymbolicLink()||hash(fs.readlinkSync(item))!==entry.sha256)fail(`inventory symlink mismatch: ${entry.path}`)}else if(entry.type!=="directory"||!stats.isDirectory())fail(`inventory type mismatch: ${entry.path}`)}
const bom=json("bom.cdx.json"),sources=json("SOURCE_MANIFEST.json"),summary=json("COMPLIANCE_SUMMARY.json");
if(bom.bomFormat!=="CycloneDX"||!Array.isArray(bom.components)||bom.components.length===0)fail("SBOM is empty or invalid");
if(sources.schemaVersion!=="yt2sheet-source-manifest/1"||!Array.isArray(sources.sources)||sources.sources.length===0)fail("source manifest is empty or invalid");
if(summary.schemaVersion!=="yt2sheet-compliance-summary/1"||summary.componentCount<1||summary.licenseCount<1)fail("compliance summary is empty or invalid");
for(const name of ["SOURCE_MANIFEST.json","THIRD_PARTY_NOTICES.md","bom.cdx.json"])if(summary.artifacts?.[name]!==hash(read(name)))fail(`compliance artifact hash mismatch: ${name}`);
if(read("THIRD_PARTY_NOTICES.md").toString("utf8").trim().length===0)fail("third-party notices are empty");
const thirdParty=path.join(root,"THIRD_PARTY"), files=[]; (function visit(dir){for(const name of fs.readdirSync(dir)){const item=path.join(dir,name),stats=fs.lstatSync(item);if(stats.isDirectory())visit(item);else if(stats.isFile())files.push(item)}})(thirdParty);
if(files.length===0||files.some((file)=>fs.statSync(file).size===0))fail("third-party license/source files are empty");
process.stdout.write("YT2SHEET_BUNDLE_VALID=1");
' "$staging_root" "$target")"
if [ "$validation_output" != "YT2SHEET_BUNDLE_VALID=1" ]; then
  printf '번들 Node 런타임이 검증을 완료하지 못했습니다.\n' >&2
  exit 1
fi
install_step "파일 설치 중"
if [ -e "$install_root" ] || [ -L "$install_root" ]; then
  mv "$install_root" "$backup_root"
fi
swapped=1
mv "$staging_root" "$install_root"
mkdir -p "$bin_dir"
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
installed=1
rm -rf "$backup_root"

printf 'yt2 설치 완료: %s\n' "$bin_dir/yt2"
printf '현재 셸에서 바로 실행: %s "https://www.youtube.com/watch?v=..."\n' "$bin_dir/yt2"
printf '도움말을 보려면 새 터미널에서 다음을 실행하세요: yt2 help\n'
printf '새 터미널에서 다음처럼 실행하세요: yt2 "https://www.youtube.com/watch?v=..."\n'
printf '삭제하려면: yt2 uninstall\n'
