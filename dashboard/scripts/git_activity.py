"""Read Git operation receipts and legacy evidence without guessing ownership."""
import json
from pathlib import Path

LABELS = {
    'baseline.recorded':'工作区基线', 'workspace.created':'创建隔离工作区',
    'integration.input':'保存集成输入', 'integration.merged':'合并集成输入',
    'integration.conflict':'集成冲突', 'integration.checkpoint':'保存集成检查点',
    'patch.applied':'应用到目标工作区', 'delivery.committed':'登记交付提交',
    'workspace.cleaned':'工作区清理完成', 'workspace.cleanup_blocked':'工作区清理受阻',
    'finalization.blocked':'交付流程受阻',
}


def read_operations(root, jobs, read_json, warnings):
    if not root:return []
    operations={}
    # Receipts win over their event-log projections, including after a crash.
    for file in sorted(root.glob('runs/*/git-operations/*.json')):
        value=read_json(file,warnings)
        if value.get('operation_id') and value.get('kind') in LABELS:
            operations[value['operation_id']]={**value,'source_file':str(file),'provenance':'operation-receipt'}
    log=root/'events.jsonl'
    try:
        with log.open(encoding='utf-8-sig') as stream:
            for number,line in enumerate(stream,1):
                try:
                    event=json.loads(line);value=event.get('git_operation') or {}
                    if value.get('operation_id') and value.get('kind') in LABELS:
                        operations.setdefault(value['operation_id'],{**value,'source_file':str(log),'source_line':number,'provenance':'event-log'})
                except (ValueError,AttributeError,TypeError):
                    warnings.append({'file':str(log),'message':f'第 {number} 行事件不可读，其他事件已保留'})
    except FileNotFoundError:pass
    except OSError:warnings.append({'file':str(log),'message':'事件日志暂不可读'})
    for job in jobs:
        job_id=job.get('id') or Path(job['_file']).parent.name
        directory=Path(job['_file']).parent
        evidence=read_json(directory/'evidence.json')
        receipt=read_json(directory/'finalization/receipt.json')
        workspace=job.get('workspace') or evidence.get('workspace') or {}
        def fallback(kind, when=None, key='', **fact):
            # A legacy timestamp or receipt is not a second operation.
            if any(o.get('job_id')==job_id and o.get('kind')==kind and (not key or o.get('source_job_id')==key) for o in operations.values()):return
            identifier=f'legacy:{job_id}:{kind}:{key}'
            operations[identifier]={'operation_id':identifier,'kind':kind,'job_id':job_id,'task_id':job.get('task_id'),
                'status':'completed','occurred_at':when,'recorded_at':None,'workspace':workspace.get('path'),
                'source_file':job['_file'],'provenance':'legacy-fields',**fact}
        base=workspace.get('base_commit') or (workspace.get('git') or {}).get('head')
        if base and not any(o.get('job_id')==job_id and o.get('kind')=='workspace.created' for o in operations.values()):
            fallback('baseline.recorded',after_head=base,commit_id=base)
        for item in job.get('integration_inputs') or evidence.get('integration_inputs') or []:
            if isinstance(item,dict) and item.get('commit'):
                fallback('integration.input',key=item.get('id',''),source_job_id=item.get('id'),commit_id=item['commit'],after_head=item['commit'],ref=item.get('reference'),source_file=str(directory/'evidence.json'))
        if evidence.get('integration_checkpoint'):
            fallback('integration.checkpoint',after_head=evidence['integration_checkpoint'],commit_id=evidence['integration_checkpoint'],source_file=str(directory/'evidence.json'))
        if job.get('applied_at'):fallback('patch.applied',job['applied_at'],workspace=job.get('project_dir'),patch_digest=(evidence.get('changes') or {}).get('patch_digest'))
        commit=job.get('commit_id') or receipt.get('commit_id')
        if commit:
            # Integrated child jobs reference the delivery; they did not each commit.
            if not job.get('integrated_into_job_id'):
                fallback('delivery.committed',job.get('committed_at'),commit_id=commit,after_head=commit,workspace=job.get('project_dir'),manual=job.get('manual_commit_recorded',False))
        if job.get('cleaned_at'):fallback('workspace.cleaned',job['cleaned_at'],commit_id=commit)
    # Continuations can share one workspace/base. Preserve all associations,
    # while presenting this single baseline fact only once.
    baselines={}
    for identifier,operation in list(operations.items()):
        if operation['kind']!='baseline.recorded' or not operation.get('workspace'):continue
        key=(str(operation['workspace']).replace('\\','/').lower(),operation.get('after_head'))
        previous=baselines.get(key)
        if previous:
            previous.setdefault('related_job_ids',[]).append(operation.get('job_id'))
            del operations[identifier]
        else:baselines[key]=operation
    return list(operations.values())


def plan_activity(operations, plan_id, job_by_id):
    result=[]
    for operation in operations:
        related=[job_by_id.get(identifier) for identifier in [operation.get('job_id'),operation.get('source_job_id'),*operation.get('related_job_ids',[])]]
        if not any(j and j.get('resolved_plan_id')==plan_id for j in related) and plan_id not in operation.get('resolved_plan_ids',[]):continue
        owner=job_by_id.get(operation.get('job_id')) or {}
        result.append({'id':operation['operation_id'],'kind':'git','git_kind':operation['kind'],
            'job_id':operation.get('job_id'),'task_id':owner.get('task_id') or operation.get('task_id'),
            'unit_id':'Git · 工作区管理' if operation['kind'].startswith('workspace.') else 'Git · 隔离工作区' if operation['kind'].startswith(('integration.','baseline.')) else 'Git · 目标工作区',
            'title':LABELS[operation['kind']],'status':operation.get('status') or 'unknown',
            'start':operation.get('occurred_at'),'end':operation.get('occurred_at'),
            'commit_id':operation.get('commit_id') or operation.get('after_head'),
            'operation':operation,'source_file':operation.get('source_file')})
    return result
