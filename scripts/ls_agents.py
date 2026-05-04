#!/usr/bin/env python3
import requests, os, json, sys

def sanitize(text):
    return ''.join(ch if ord(ch) >= 32 or ch in '\n\r\t' else ' ' for ch in text)

def get_json(url, headers):
    resp = requests.get(url, headers=headers)
    if not resp.ok:
        print('HTTP', resp.status_code, file=sys.stderr)
        sys.exit(1)
    return json.loads(sanitize(resp.text))

url = os.environ['PAPERCLIP_API_URL'] + '/api/companies/' + os.environ['PAPERCLIP_COMPANY_ID'] + '/agents'
headers = {'Authorization': 'Bearer ' + os.environ['PAPERCLIP_API_KEY'], 'X-Paperclip-Run-Id': os.environ['PAPERCLIP_RUN_ID']}
data = get_json(url, headers)
for a in data.get('agents', []):
    print(a.get('id'), a.get('name'), a.get('role'))
