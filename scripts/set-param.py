# Tuning helper: python scripts/set-param.py <link_id> <param_or_factor.idx.field> <value>
import json, re, sys
path = 'data/links.json'
text = open(path, encoding='utf-8').read()
links = json.loads(text)
link_id, field, value = sys.argv[1], sys.argv[2], float(sys.argv[3])
link = next(l for l in links if l['id'] == link_id)
if field.startswith('factor.'):
    _, idx, name = field.split('.')
    link['factors'][int(idx)][name] = value
else:
    link['params'][field] = value
# Rewrite only the touched link's block so the rest of the file keeps its formatting.
start = text.index(f'"id": "{link_id}"')
block_start = text.rindex('{', 0, start)
depth, i = 0, block_start
while True:
    if text[i] == '{': depth += 1
    elif text[i] == '}':
        depth -= 1
        if depth == 0: break
    i += 1
old = text[block_start:i + 1]
new = old
if field.startswith('factor.'):
    fl = re.findall(r'\{ "var"[^}]*\}', old)[int(idx)]
    nf = re.sub(rf'"{name}": [-0-9.e]+', f'"{name}": {value:g}', fl)
    new = old.replace(fl, nf)
else:
    new = re.sub(rf'("params": \{{[^}}]*"{field}": )[-0-9.e]+', rf'\g<1>{value:g}', old)
open(path, 'w', encoding='utf-8').write(text.replace(old, new))
print(link_id, field, '=', value)
