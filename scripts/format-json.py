# Rewrites a data file with one object per block and small objects/arrays kept inline.
# Usage: python scripts/format-json.py data/links.json
import json, sys

def inline(v):
    s = json.dumps(v, ensure_ascii=False)
    if isinstance(v, dict) and v:
        s = '{ ' + s[1:-1] + ' }'
    return s

def fmt(obj, indent=0):
    pad = '  ' * indent
    if isinstance(obj, list):
        if all(not isinstance(x, (dict, list)) for x in obj) or (obj and all(isinstance(x, dict) and len(inline(x)) < 90 for x in obj) and indent > 0):
            if len(inline(obj)) < 100 and all(not isinstance(x, (dict, list)) for x in obj):
                return inline(obj)
            return '[\n' + ',\n'.join(pad + '  ' + inline(x) for x in obj) + '\n' + pad + ']'
        return '[\n' + ',\n'.join(pad + '  ' + fmt(x, indent + 1) for x in obj) + '\n' + pad + ']'
    if isinstance(obj, dict):
        if indent > 1 and len(inline(obj)) < 100:
            return inline(obj)
        items = [f'{pad}  {json.dumps(k, ensure_ascii=False)}: {fmt(v, indent + 1)}' for k, v in obj.items()]
        return '{\n' + ',\n'.join(items) + '\n' + pad + '}'
    return json.dumps(obj, ensure_ascii=False)

for path in sys.argv[1:]:
    data = json.load(open(path, encoding='utf-8'))
    open(path, 'w', encoding='utf-8').write(fmt(data) + '\n')
