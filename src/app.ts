import Fastify, { LogController } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CipaClient } from './client.js';
import { loadConfig, type Config } from './config.js';
import { ApiError } from './errors.js';
import { schemas, envelope, errorResponses } from './schema.js';
import type { RegistryProvider } from './types.js';

// Company UIN or business-name registration number; Fastify decodes %2F into the slash.
const ENTITY_ID_PATTERN='^(?:[Bb][Ww][0-9]{5,20}|[Bb][Nn][0-9]{4}/[0-9]{1,10})$';
// The guide is one self-contained page beside src/ and dist/, so both resolve it the same way.
const GUIDE_URL=new URL('../docs/index.html',import.meta.url);
// The guide shows registry text and calls only this server; it loads nothing from anywhere else.
const GUIDE_CSP="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// Names a server with no API key may be addressed by; ALLOWED_HOSTS adds to them.
const LOCAL_HOSTS=['localhost','127.0.0.1','[::1]'];
/** The hostname of a Host header, without its port. IPv6 literals keep their brackets. */
const hostName=(header: string | undefined): string => { const value=(header ?? '').trim().toLowerCase(); return value.startsWith('[') ? value.slice(0,value.indexOf(']')+1) : value.split(':')[0]; };
const ENTITY_ID_DESCRIPTION='A company UIN (BW followed by 5 to 20 digits), or a business-name registration number (BN, the year, a slash and a number) with the slash written as %2F.';
export async function buildApp(config: Config = loadConfig(), provider?: RegistryProvider) {
  const guide = await readFile(GUIDE_URL).catch(() => null);
  const app = Fastify({ logger: { level:'info', redact:['req.headers.authorization'] }, logController:new LogController({disableRequestLogging:true}),
    pluginTimeout:config.actionTimeoutMs+5000,
    bodyLimit:1024, requestTimeout:Math.max(config.operationTimeoutMs,config.documentTimeoutMs) + config.queueTimeoutMs + 5000,
    ajv:{customOptions:{removeAdditional:false}} });
  const client = new CipaClient(config, provider);
  await app.register(rateLimit, { max:config.rateLimit, timeWindow:'1 minute' });
  await app.register(swagger, { openapi:{info:{title:'CIPAget',version:'0.1.0',description:'Independent, on-demand API for CIPA public register facts. No official affiliation. Section completeness is explicit. Public PDFs are available through the separate documents endpoint.'},externalDocs:{url:'/docs/',description:'Guide in plain English, with forms that send live requests'},tags:[{name:'Registry',description:'Live lookups on CIPA\'s public register search. Nothing is fetched until you ask.'},{name:'Documents',description:'The two free PDFs CIPA offers for an entity.'}],components:{securitySchemes:{bearerAuth:{type:'http',scheme:'bearer'}}}} });
  for (const schema of schemas) app.addSchema(schema);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control','no-store');
    // With no key the server is local-only. A page elsewhere can point its own hostname at this
    // machine (DNS rebinding) and would then read answers as if it were local, so the name must match.
    if (!config.apiKey && ![...LOCAL_HOSTS,...config.allowedHosts].includes(hostName(request.headers.host))) throw new ApiError('HOST_NOT_ALLOWED','This server has no API key, so it only answers requests addressed to localhost. Set API_KEY, or add the hostname to ALLOWED_HOSTS.',403);
    // Decide by the matched route, not the raw URL: the router decodes percent-encoding, so /%76%31/search is /v1/search.
    if (!request.routeOptions.url?.startsWith('/v1/')) return;
    // A lookup makes this server contact CIPA, so a page on another site must not be able to start one.
    // Current browsers say where a request came from. One that does not is refused rather than trusted;
    // command-line and server-side clients send neither signal and are unaffected.
    const site=request.headers['sec-fetch-site'], browser=site !== undefined || /^mozilla\//i.test(request.headers['user-agent'] ?? '');
    if (browser && site !== 'same-origin' && site !== 'none') throw new ApiError('CROSS_SITE_REQUEST','Browser requests are accepted only from this server\'s own pages.',403);
    if (!config.apiKey) return;
    const supplied = Buffer.from(request.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${config.apiKey}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied,expected)) throw new ApiError('UNAUTHORIZED','A valid Bearer API key is required.',401);
  });
  app.addHook('onResponse', async (request,reply) => {
    app.log.info({route:request.routeOptions.url,statusCode:reply.statusCode,durationMs:Math.round(reply.elapsedTime),requestId:request.id},'request completed');
  });
  app.setErrorHandler((error,request,reply) => {
    const known = error instanceof ApiError;
    const details = error as { validation?: unknown; statusCode?: number };
    const statusCode = known ? error.statusCode : details.validation ? 400 : details.statusCode === 429 ? 429 : 500;
    if (statusCode >= 500) app.log.warn({code:known ? error.code : 'INTERNAL_ERROR',requestId:request.id},'request failed');
    if (statusCode === 503 || statusCode === 429) reply.header('Retry-After', '60');
    return reply.code(statusCode).send({error:{
      code:known ? error.code : statusCode === 400 ? 'INVALID_REQUEST' : statusCode === 429 ? 'RATE_LIMITED' : 'INTERNAL_ERROR',
      message:known ? error.message : statusCode === 400 ? 'Invalid request parameters.' : statusCode === 429 ? 'Too many requests. Retry later.' : 'An internal error occurred.',
      retryable:known ? error.retryable : statusCode === 429,requestId:request.id,
    }});
  });
  app.setNotFoundHandler((request,reply) => reply.code(404).send({error:{code:'ROUTE_NOT_FOUND',message:'Route not found.',retryable:false,requestId:request.id}}));
  app.get('/healthz', {schema:{hide:true}},async () => ({status:'ok',...client.stats}));
  const security = config.apiKey ? [{bearerAuth:[]}] : [];
  app.get<{Querystring:{q:string;page?:number;pageSize?:number}}>('/v1/search', {
    schema:{summary:'Search the register by name or number',tags:['Registry'],security,
      description:'Finds companies and business names the way the “Name or number” box on CIPA\'s site does. Each match comes back with its number, status, type, registration date and address. Usually takes 0.4 to 2 seconds. Limits: you can search by name or number only, with no filters for type, status or date. Results come 20, 50 or 100 to a page, up to page 20. total can be null, so use hasMore to page. Business names come back without a number (uin is null), so their details cannot be opened from a search result.',
      querystring:{type:'object',additionalProperties:false,required:['q'],properties:{
        q:{type:'string',minLength:2,maxLength:200,description:'A name or part of one, a company UIN, or a business-name registration number. 2 to 200 characters.',examples:['Choppies']},
        page:{type:'integer',minimum:1,maximum:20,default:1,description:'Which page of results to return, 1 to 20.'},
        pageSize:{type:'integer',enum:[20,50,100],default:20,description:'Results per page.'}}},
      response:{200:envelope('SearchResult'),...errorResponses}},
  },async (request,reply) => { const result=await client.search(request.query); reply.header('X-Cache',result.meta.cache); return result; });
  app.get<{Params:{uin:string};Querystring:{include?:string;history?:boolean;filingDetails?:boolean;maxPages?:number}}>('/v1/entities/:uin',{
    schema:{summary:'Read one company or business name',tags:['Registry'],security,
      description:'Opens one entity on CIPA\'s site and reads its tabs: general details, addresses, directors, secretaries, shareholders, share allocations, beneficial owners, auditors, the ownership diagram\'s data and the list of filings. By default it reads every tab, including previous names, addresses and office holders. A full read takes about 2.5 to 7 seconds; include=general takes about 2. Limits: it needs the exact number, not a name, so search first. Each list is read up to maxPages pages; when a list is longer, complete is false and warnings says which section stopped early. Ownership data covers the entity\'s direct owners only; related companies are not opened. PDFs are not included here; use /v1/entities/{uin}/documents.',
      params:{type:'object',required:['uin'],properties:{uin:{type:'string',pattern:ENTITY_ID_PATTERN,description:ENTITY_ID_DESCRIPTION,examples:['BW00000790718']}}},
      querystring:{type:'object',additionalProperties:false,properties:{
        include:{type:'string',default:'all',maxLength:1000,description:'Section keys separated by commas, or all on its own. Fewer sections means a faster call. Common keys: general, addresses, directors, secretaries, shareholders, shareAllocations, beneficialOwners, auditors, visualisation, filings.',examples:['general,addresses']},
        history:{type:'boolean',default:true,description:'Also read the “show previous” lists: former directors, old addresses, earlier names and statuses.'},
        filingDetails:{type:'boolean',default:false,description:'Also open each filing\'s own dialog. Much slower.'},
        maxPages:{type:'integer',minimum:1,maximum:20,default:10,description:'The most pages to read in any one list.'}}},
      response:{200:envelope('EntityResult'),...errorResponses}},
  },async (request,reply) => {
    const result=await client.getEntity(request.params.uin,{...request.query,include:request.query.include?.split(',').map(key=>key.trim())});
    reply.header('X-Cache',result.meta.cache); return result;
  });
  app.get<{Params:{uin:string}}>('/v1/entities/:uin/documents',{
    schema:{summary:'Download the certificate and standard extract',tags:['Documents'],security,
      description:'Fetches the two free PDFs CIPA offers for an entity and returns them inside the JSON as base64, each with its filename, size in bytes and a SHA-256 hash. CIPA builds these PDFs on request, so this commonly takes 10 to 20 seconds; the limit is DOCUMENT_TIMEOUT_MS (180 seconds by default). Limits: only these two documents; nothing is bought, emailed or logged in to. Each PDF can be at most 10 MiB. One document request runs at a time. A document CIPA does not offer comes back with status unavailable and no content. The hash describes the bytes returned; it does not check a digital signature.',
      params:{type:'object',required:['uin'],properties:{uin:{type:'string',pattern:ENTITY_ID_PATTERN,description:ENTITY_ID_DESCRIPTION,examples:['BW00000790718']}}},querystring:{type:'object',additionalProperties:false},
      response:{200:envelope('DocumentsResult'),...errorResponses}},
  },async(request,reply)=>{const result=await client.getDocuments(request.params.uin);reply.header('X-Cache',result.meta.cache);return result;});
  if (guide) {
    app.get('/docs/',{schema:{hide:true}},async(_request,reply)=>reply.type('text/html; charset=utf-8').header('Content-Security-Policy',GUIDE_CSP).header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer').send(guide));
    for (const url of ['/','/docs']) app.get(url,{schema:{hide:true}},async(_request,reply)=>reply.redirect('/docs/'));
  } else app.log.warn('docs/index.html was not found; the guide at /docs/ is not served.');
  app.get('/openapi.json',{schema:{hide:true}},async()=>app.swagger());
  app.addHook('preClose',async()=>client.close());
  if (config.prewarm) app.addHook('onReady', async () => {
    // Load the public search form, not company records. Failure leaves normal retry-on-request available.
    const started = performance.now();
    try { await client.warmup(); app.log.info({durationMs:Math.round(performance.now()-started)},'browser prepared'); }
    catch { app.log.warn('Browser preparation was incomplete; lookups will create sessions as needed.'); }
  });
  try {await app.ready();}
  catch(error){await client.close();await app.close().catch(()=>{});throw error;}
  return app;
}
