"""Read-only local Git data for the Auditor. No fetch, checkout or index refresh."""
import os
import re
import subprocess
from datetime import datetime, timezone


class GitReadError(ValueError):
    pass


def run_git(cwd, *args, allow_failure=False):
    root = os.path.abspath(cwd)
    result = subprocess.run(
        ['git', '-c', 'safe.directory=' + root.replace('\\', '/'), '--no-optional-locks', '-C', root, *args],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20,
        env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0', 'GIT_TERMINAL_PROMPT': '0'},
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
    )
    if result.returncode:
        if allow_failure:
            return None
        raise GitReadError(result.stderr.decode('utf-8', errors='replace').strip() or 'Git 读取失败')
    return result.stdout.decode('utf-8', errors='replace')


def git_state(cwd):
    root = run_git(cwd, 'rev-parse', '--show-toplevel').strip()
    status = {'branch':'', 'head':'', 'upstream':'', 'ahead':0, 'behind':0,
              'staged':0, 'unstaged':0, 'untracked':0, 'conflicts':0, 'files':[]}
    entries = run_git(cwd, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal').split('\0')
    i = 0
    while i < len(entries):
        entry = entries[i]
        for key, prefix in [('branch','# branch.head '),('head','# branch.oid '),('upstream','# branch.upstream ')]:
            if entry.startswith(prefix):
                status[key] = entry[len(prefix):]
        if entry.startswith('# branch.ab '):
            match = re.search(r'\+(\d+) -(\d+)', entry)
            if match:
                status['ahead'], status['behind'] = map(int, match.groups())
        elif entry.startswith('? '):
            status['untracked'] += 1
            status['files'].append({'xy':'??','path':entry[2:]})
        elif entry[:2] in ('1 ', '2 ', 'u '):
            xy = entry[2:4]
            count = 8 if entry[0] == '1' else 9 if entry[0] == '2' else 10
            item = {'xy':xy,'path':' '.join(entry.split(' ')[count:])}
            if entry[0] == 'u':
                status['conflicts'] += 1
            else:
                status['staged'] += xy[0] != '.'
                status['unstaged'] += xy[1] != '.'
            if entry[0] == '2':
                i += 1
                item['original'] = entries[i]
            status['files'].append(item)
        i += 1
    return {'repository':root,'name':os.path.basename(root),'status':status,
            'git_dir':run_git(cwd,'rev-parse','--absolute-git-dir').strip(),
            'git_common_dir':run_git(cwd,'rev-parse','--path-format=absolute','--git-common-dir').strip()}


def snapshot(cwd, ref='', limit=150, include_internal=False):
    limit = max(20, min(2000, int(limit)))
    state = git_state(cwd)
    raw = run_git(cwd,'for-each-ref','--format=%(refname)%00%(objectname)%00%(symref)%00', 'refs/heads','refs/remotes','refs/tags',*(['refs/agent-orch'] if include_internal else []))
    parts = raw.split('\0')
    refs = []
    for i in range(0,len(parts)-2,3):
        name = parts[i].strip()
        if not name or parts[i+2]:
            continue
        kind = 'branch' if name.startswith('refs/heads/') else 'remote' if name.startswith('refs/remotes/') else 'internal' if name.startswith('refs/agent-orch/') else 'tag'
        sha = parts[i+1]
        if kind == 'tag':
            sha = (run_git(cwd,'rev-parse','--verify',name+'^{commit}',allow_failure=True) or '').strip()
        refs.append({'name':name,'hash':sha,'kind':kind,'label':re.sub(r'^refs/(heads|remotes|tags)/','',name)})
    if ref and not any(r['name']==ref for r in refs):
        raise GitReadError('所选分支已不存在，请选择全部分支。')
    has_head = state['status']['head'] not in ('','(initial)')
    revisions = [ref] if ref else ['--branches','--remotes','--tags']+(['HEAD'] if has_head else [])+([r['name'] for r in refs if r['kind']=='internal'] if include_internal else [])
    commits, ids = [], []
    if has_head or any(r['hash'] for r in refs):
        for line in run_git(cwd,'rev-list','--timestamp',*revisions,'--').splitlines():
            stamp, sha = line.split(' ',1)
            ids.append((int(stamp),sha))
        ids.sort(key=lambda item:item[0],reverse=True)
        visible = ids[:limit]
        found = {}
        for start in range(0,len(visible),128):
            fields = run_git(cwd,'log','--no-walk=unsorted','--format=%H%x00%P%x00%an%x00%cI%x00%s%x00%B%x00%aI%x00',*[sha for _,sha in visible[start:start+128]],'--').split('\0')
            for i in range(0,len(fields)-6,7):
                sha = fields[i].strip()
                found[sha] = {'hash':sha,'parents':fields[i+1].split(),'author':fields[i+2],
                              'date':fields[i+3],'subject':fields[i+4],'message':fields[i+5].rstrip(),'author_date':fields[i+6]}
        commits = [found[sha] for _,sha in visible if sha in found]
    return {**state,'refs':refs,'commits':commits,'has_more':len(ids)>limit,'limit':limit,'order':'committer-date-desc','generated_at':datetime.now(timezone.utc).isoformat()}


def commit_status(cwd, sha):
    if not isinstance(sha,str) or not re.fullmatch(r'[a-f0-9]{40}|[a-f0-9]{64}',sha):
        return {'commit_id':sha,'state':'invalid','exists':False,'reachable':False}
    exists = run_git(cwd,'cat-file','-t',sha,allow_failure=True)
    if not exists or exists.strip() != 'commit':
        return {'commit_id':sha,'state':'missing','exists':False,'reachable':False}
    reachable = run_git(cwd,'merge-base','--is-ancestor',sha,'HEAD',allow_failure=True) is not None
    return {'commit_id':sha,'state':'committed' if reachable else 'other_branch','exists':True,'reachable':reachable}


def commit_detail(cwd, sha):
    checked = commit_status(cwd,sha)
    if not checked['exists']:
        raise GitReadError('提交 ID 无效或 Git 对象不存在。')
    text = run_git(cwd,'show','--no-ext-diff','--no-textconv','--format=fuller','--stat','--patch','--no-renames',sha,'--')
    return {**checked,'text':text[:256*1024],'truncated':len(text)>256*1024}
