#!/usr/bin/env python
# -*- coding: utf-8 -*-

from io import open
import json
import sys

def main():
    if len(sys.argv) is 1:
        print 'Usage: python sync-langs.py en zh-TW'
    elif len(sys.argv) is 2:
        first = sys.argv[1]
        second = 'en'
    else:
        first = sys.argv[1]
        second = sys.argv[2]
    f1=open('%s.i18n.json' % first,'r')
    f2=open('%s.i18n.json' % second ,'r')
    j1 = json.loads(f1.read())
    j2 = json.loads(f2.read())
    f1.close()
    f2.close()

    r2 = comp_dict(j1, dict(j2))
    with open('%s.i18n.json' % second,'w',encoding='utf-8') as out:
        out.write(json.dumps(r2, indent=2, sort_keys=True, ensure_ascii=False))

    r1 = comp_dict(j2, dict(j1))
    with open('%s.i18n.json' % first,'w',encoding='utf-8') as out:
        out.write(json.dumps(r1, indent=2, sort_keys=True, ensure_ascii=
            False))

    print 'Done.'

def comp_dict(base, comp):
    for key, value in base.iteritems():
        if key in comp:
            if type(comp[key]) != type(value):
                print 'Type mismatch!! Key=%s' % key
            if type(value) is dict:
                comp[key] = comp_dict(value, comp[key])
        else:
            if type(value) is unicode:
                comp[key] = "__%s" % value
            elif type(value) is dict:
                comp[key] = comp_dict(value, {})
    return comp

main()
