#!/usr/bin/env python3
"""Mac Keychain adapter. Secrets use a hidden terminal prompt or a captured pipe, never argv."""
import ctypes as C, json, sys, re, getpass

def main():
    if sys.platform != 'darwin': raise RuntimeError('This credential adapter requires macOS Keychain')
    if len(sys.argv)!=3 or sys.argv[1] not in ('get','set') or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,63}',sys.argv[2]): raise RuntimeError('Usage: keychain-credential.py set|get reference')
    sec=C.CDLL('/System/Library/Frameworks/Security.framework/Security');cf=C.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
    ptr=C.c_void_p; holders=[]
    cf.CFStringCreateWithCString.argtypes=[ptr,C.c_char_p,C.c_uint32];cf.CFStringCreateWithCString.restype=ptr
    cf.CFDataCreate.argtypes=[ptr,C.c_void_p,C.c_long];cf.CFDataCreate.restype=ptr
    cf.CFDictionaryCreateMutable.argtypes=[ptr,C.c_long,ptr,ptr];cf.CFDictionaryCreateMutable.restype=ptr
    cf.CFDictionarySetValue.argtypes=[ptr,ptr,ptr];cf.CFRelease.argtypes=[ptr]
    sec.SecItemCopyMatching.argtypes=[ptr,C.POINTER(ptr)];sec.SecItemCopyMatching.restype=C.c_int32
    sec.SecItemAdd.argtypes=[ptr,ptr];sec.SecItemAdd.restype=C.c_int32
    sec.SecItemUpdate.argtypes=[ptr,ptr];sec.SecItemUpdate.restype=C.c_int32
    cf.CFDataGetLength.argtypes=[ptr];cf.CFDataGetLength.restype=C.c_long
    cf.CFDataGetBytePtr.argtypes=[ptr];cf.CFDataGetBytePtr.restype=ptr
    def constant(name):return ptr.in_dll(sec,name)
    def string(s):
        value=cf.CFStringCreateWithCString(None,s.encode(),0x08000100);holders.append(value);return value
    def dictionary(items):
        value=cf.CFDictionaryCreateMutable(None,0,None,None);holders.append(value)
        for k,v in items:cf.CFDictionarySetValue(value,constant(k),v)
        return value
    base=[('kSecClass',constant('kSecClassGenericPassword')),('kSecAttrService',string('com.angel.agentos.environment.'+sys.argv[2])),('kSecAttrAccount',string('agentos'))]
    try:
        if sys.argv[1]=='set':
            if not sys.stdin.isatty():raise RuntimeError('Credential entry requires a local interactive terminal')
            username=input('Environment account: ').strip();password=getpass.getpass('Environment password (hidden): ')
            if not username or not password:raise RuntimeError('Empty credential')
            raw=json.dumps({'username':username,'password':password}).encode();buf=C.create_string_buffer(raw);data=cf.CFDataCreate(None,buf,len(raw));holders.append(data)
            code=sec.SecItemAdd(dictionary(base+[('kSecValueData',data)]),None)
            if code==-25299:code=sec.SecItemUpdate(dictionary(base),dictionary([('kSecValueData',data)]))
            if code:raise RuntimeError('Keychain write failed; unlock the login keychain')
            print('Credential saved to this Mac Keychain. No secret written to configuration.')
        else:
            result=ptr();query=dictionary(base+[('kSecReturnData',ptr.in_dll(cf,'kCFBooleanTrue'))]);code=sec.SecItemCopyMatching(query,C.byref(result))
            if code:raise RuntimeError('Keychain credential unavailable; configure or unlock locally')
            holders.append(result);raw=C.string_at(cf.CFDataGetBytePtr(result),cf.CFDataGetLength(result))
            if sys.stdout.isatty():raise RuntimeError('Refusing to print credentials to a terminal')
            sys.stdout.buffer.write(raw)
    finally:
        for value in reversed(holders):cf.CFRelease(value)
if __name__=='__main__':
    try:main()
    except Exception as error:
        # Never include raw credential data, API payloads or values in errors.
        print('Local credential operation failed. Check macOS Keychain access and terminal input.',file=sys.stderr);sys.exit(1)
