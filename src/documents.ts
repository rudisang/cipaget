import { createHash } from 'node:crypto';
import type { Download } from 'playwright';
import { ApiError } from './errors.js';
import type { DocumentKind, RegistryDocument } from './types.js';

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export function unavailableDocument(kind: DocumentKind): RegistryDocument {
  return { kind, status:'unavailable', filename:null, mimeType:'application/pdf', encoding:'base64', contentBase64:null,
    sizeBytes:null, sha256:null, retrievedAt:null, warnings:[] };
}
export function encodeDocument(kind: DocumentKind, filename: string, bytes: Buffer): RegistryDocument {
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new ApiError('DOCUMENT_TOO_LARGE','The document exceeds the 10 MiB inline limit.');
  if (bytes.length < 8 || bytes.subarray(0,5).toString('ascii') !== '%PDF-' || !bytes.subarray(-1024).includes(Buffer.from('%%EOF'))) {
    throw new ApiError('INVALID_DOCUMENT','CIPA did not return a complete PDF document.',502,true);
  }
  const safe=filename.replace(/[\\/\u0000-\u001f\u007f]/g,'_');
  return { kind, status:'available', filename:safe.length>200?`${safe.slice(0,140)}-${safe.slice(-59)}`:safe, mimeType:'application/pdf', encoding:'base64',
    contentBase64:bytes.toString('base64'),sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),retrievedAt:new Date().toISOString(),warnings:[] };
}
export async function readDocument(kind: DocumentKind, download: Download): Promise<RegistryDocument> {
  try {
    const url=new URL(download.url());
    // Companies serve from /companies/, business names from /businessnames/ (observed: template and document routes).
    const prefix=new RegExp(`^/(?:companies|businessnames)/${kind==='incorporationCertificate'?'template':'document'}/`);
    if(url.origin!=='https://www.cipa.co.bw'||!prefix.test(url.pathname)) {
      await download.cancel();throw new ApiError('UNEXPECTED_DOCUMENT_SOURCE','The download did not come from CIPA’s document service.');
    }
    const stream=await download.createReadStream();
    if(!stream) throw new ApiError('DOCUMENT_DOWNLOAD_FAILED','CIPA did not supply a readable document.',502,true);
    const chunks:Buffer[]=[];let bytes=0;
    for await(const part of stream) {
      const chunk=Buffer.from(part);bytes+=chunk.length;
      if(bytes>MAX_DOCUMENT_BYTES){stream.destroy();throw new ApiError('DOCUMENT_TOO_LARGE','The document exceeds the 10 MiB inline limit.');}
      chunks.push(chunk);
    }
    return encodeDocument(kind,download.suggestedFilename(),Buffer.concat(chunks));
  } finally {await download.delete().catch(()=>{});}
}
