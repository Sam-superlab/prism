import json,re
from pathlib import Path
from openapi_spec_validator import validate
root=Path(__file__).resolve().parents[2]
s=json.loads((root/'docs/api/openapi.json').read_text())
validate(s)
ids=[]
refs=[]
def walk(x):
 if isinstance(x,dict):
  if '$ref' in x:refs.append(x['$ref'])
  for v in x.values():walk(v)
 elif isinstance(x,list):
  for v in x:walk(v)
walk(s)
for ref in refs:
 assert ref.startswith('#/')
 x=s
 for token in ref[2:].split('/'):x=x[token.replace('~1','/').replace('~0','~')]
for path,item in s['paths'].items():
 for method,op in item.items():
  ids.append(op['operationId']);params=[]
  for p in op['parameters']:
   if '$ref' in p:p=s['components']['parameters'][p['$ref'].split('/')[-1]]
   params.append(p)
  assert set(re.findall(r'{([^}]+)}',path))=={p['name'] for p in params if p['in']=='path'}
  if method!='get':assert any(p['name']=='Idempotency-Key' and p.get('required') for p in params)
  if method in ['patch','delete']:assert any(p['name']=='If-Match' and p.get('required') for p in params)
assert len(ids)==len(set(ids))
print(json.dumps({'openapi':s['openapi'],'paths':len(s['paths']),'operations':len(ids),'schemas':len(s['components']['schemas']),'resolved_refs':len(refs)}))
