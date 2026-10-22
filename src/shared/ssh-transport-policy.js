import path from 'node:path';
export function validateSshTransport(t){
 if(!t||t.mode!=='ssh-remote-execution'||Object.keys(t).some(k=>!['mode','host','port','credentialRef','knownHostsFile'].includes(k))||typeof t.host!=='string'||!/^[a-zA-Z0-9.:-]+$/.test(t.host)||!Number.isInteger(t.port)||t.port<1||t.port>65535||!/^\w[\w-]{0,63}$/.test(t.credentialRef??'')||typeof t.knownHostsFile!=='string'||!path.isAbsolute(t.knownHostsFile))throw new Error('SSH远程数据库传输配置无效；不支持转发、隧道或本地回退');
}
