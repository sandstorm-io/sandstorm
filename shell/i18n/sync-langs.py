#!/usr/bin/env python
# -*- coding: utf-8 -*-

from io import open
import json
import sys
from collections import OrderedDict

inter_add = False;

def main():
    if len(sys.argv) is 1:
        print 'Usage: "python sync-langs.py en zh-TW". The first language has higher json order priority. If the first language is en, it can be omitted.'
    elif len(sys.argv) is 2:
        first = 'en'
        second = sys.argv[1]
    else:
        first = sys.argv[1]
        second = sys.argv[2]
    f1 = open('%s.i18n.json' % first, 'r')
    f2 = open('%s.i18n.json' % second, 'r')
    j1 = json.loads(f1.read(), object_pairs_hook=OrderedDict)
    j2 = json.loads(f2.read(),  object_pairs_hook=OrderedDict)
    f1.close()
    f2.close()

    r2raw = comp_dict(j1, j2)
    r1 = comp_dict(j2, j1)
    r2 = align_dict(j1, r2raw)

    with open('%s.i18n.json' % second,'w',encoding='utf-8') as out:
        out.write(json.dumps(r2, indent=2, ensure_ascii=False, separators=(',', ': ')))

    if inter_add:
        with open('%s.i18n.json' % first,'w',encoding='utf-8') as out:
            out.write(json.dumps(r1, indent=2, ensure_ascii=False, separators=(',', ': ')))

    print 'Done.'

def comp_dict(base, comp):
    if inter_add:
        result = OrderedDict(comp)
    else:
        result = OrderedDict()
    for key, value in base.iteritems():
        if key in comp:
            if type(comp[key]) != type(value):
                print 'Type mismatch!! Key=%s; %s %s' % (key, type(comp[key]), type(value))
            if type(value) is OrderedDict:
                result[key] = comp_dict(value, comp[key])
            else:
                result[key] = comp[key] 
        else:
            if type(value) is OrderedDict:
                result[key] = comp_dict(value, OrderedDict())
            else:
                result[key] = "*_%s" % unicode(value)
    return result

def align_dict(base, target):
    result = OrderedDict()
    for key in base:
        if type(base[key]) is OrderedDict:
            result[key] = align_dict(base[key], target[key])
        else:
            result[key] = target[key]
    return result

main()
