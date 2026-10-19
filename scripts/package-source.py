"""Build a reviewable source archive, never a copy of the working directory."""
from pathlib import Path
import re
import zipfile
import sys

root = Path(__file__).resolve().parent.parent
files = [root / name for name in ('README.md', 'README.en.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', '.gitignore', '.env.example', 'package.json', 'package-lock.json', 'requirements.txt', 'index.html', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json', 'vite.config.ts')]
if not (root / 'LICENSE').is_file():
    sys.exit('尚未选择开源协议，未生成发布包。请先确认 LICENSE。')
for folder, suffixes in [('src', {'.ts','.tsx','.css'}), ('backend',{'.py'}), ('scripts',{'.sh','.mjs','.py'}), ('tests',{'.ts','.html'}), ('public',{'.png'})]:
    files.extend(p for p in (root/folder).rglob('*') if p.is_file() and p.suffix in suffixes and '__pycache__' not in p.parts)
files.append(root/'docs/open-source-release.md')
files.append(root/'docs/deploy-overseas.md')
for name in ('Dockerfile', 'render.yaml', 'vercel.json', '.dockerignore'):
    files.append(root / name)
files.extend(p for p in (root / 'supabase').rglob('*.sql') if p.is_file())
files.extend(p for p in (root / 'deploy').rglob('*') if p.is_file())
# Fail without printing matching credentials. Manual review is still required.
patterns = [r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----', r'\b(?:sk|re)_[A-Za-z0-9]{24,}', r'\bsk-[A-Za-z0-9_-]{24,}', r'\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}']
for p in files:
    if p.is_symlink() or not p.resolve().is_relative_to(root):
        sys.exit(f'拒绝打包符号链接：{p.relative_to(root)}')
    if p.suffix == '.png': continue
    content = p.read_text()
    if any(re.search(pattern,content) for pattern in patterns):
        sys.exit(f'检测到疑似凭证，请检查：{p.relative_to(root)}（内容未输出）')
out = root/'release';out.mkdir(exist_ok=True)
archive = out/'manjinhai-source.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
    for p in sorted(set(files)): z.write(p, Path('manjinhai')/p.relative_to(root))
print(f'已生成 {archive}，共 {len(set(files))} 个文件。未上传；发布前仍需人工审核素材版权和内容。')
