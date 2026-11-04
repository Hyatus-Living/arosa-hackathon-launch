import {open} from 'node:fs/promises';
import {constants,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {executionSignal} from './execution-context.mjs';

const identity=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].map(String).join(':');
export function assertVerifiedFile(path,verified) {
  const stat=lstatSync(path,{bigint:true,throwIfNoEntry:false});
  if(!stat?.isFile()||identity(stat)!==verified.identity)throw new Error('The verified artifact changed before publication.');
}
// Hash one bounded buffer at a time, outside SQLite transactions. Opening without
// following symlinks and checking both descriptor and path prevents replacement
// during a read from turning a verified hash into a different published file.
export async function verifyFile(path,maxBytes,{signal=executionSignal(),text=false}={}) {
  signal?.throwIfAborted();
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const before=await file.stat({bigint:true});
    if(!before.isFile())throw new Error('The artifact is not a regular file.');
    if(before.size>BigInt(maxBytes))throw Object.assign(new Error('The artifact exceeds its size limit.'),{status:413});
    const hash=createHash('sha256'),chunks=[];let bytes=0;
    const buffer=Buffer.allocUnsafe(64*1024);
    for(;;){
      signal?.throwIfAborted();
      const {bytesRead}=await file.read(buffer,0,buffer.length,null);
      if(!bytesRead)break;
      bytes+=bytesRead;
      if(bytes>maxBytes)throw Object.assign(new Error('The artifact exceeds its size limit.'),{status:413});
      hash.update(buffer.subarray(0,bytesRead));
      if(text)chunks.push(Buffer.from(buffer.subarray(0,bytesRead)));
    }
    signal?.throwIfAborted();
    const after=await file.stat({bigint:true});
    if(identity(before)!==identity(after)||bytes!==Number(after.size))throw new Error('The artifact changed during verification.');
    const verified={bytes,sha256:hash.digest('hex'),identity:identity(after)};
    assertVerifiedFile(path,verified);
    return text?{...verified,text:Buffer.concat(chunks).toString('utf8')}:verified;
  }finally{await file.close();}
}
