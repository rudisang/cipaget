const text = { type:'string' };
const nullableText = { type:['string','null'] };
export const schemas = [
  { $id:'Field', type:'object', required:['key','label','value','displayValue'], properties:{ key:text,label:nullableText,value:nullableText,displayValue:text,machineValue:{type:['string','number','boolean','null']},group:text } },
  { $id:'Table', type:'object', properties:{headers:{type:'array',items:text},rows:{type:'array',items:{type:'array',items:text}}} },
  { $id:'Record', type:'object', properties:{title:nullableText,summary:{type:'array',items:text},group:nullableText,fields:{type:'array',items:{$ref:'Field#'}},text} },
  { $id:'Section', type:'object', properties:{
    label:text,status:{enum:['available','empty','unavailable','restricted','error']},fields:{type:'array',items:{$ref:'Field#'}},
    records:{type:'array',items:{$ref:'Record#'}},tables:{type:'array',items:{$ref:'Table#'}},text,
    pagesFetched:{type:'integer'},total:{type:['integer','null']},complete:{type:'boolean'},warnings:{type:'array',items:text},
    filingDetails:{type:'array',items:{type:'object',additionalProperties:true}},
    ownershipStatements:{type:'array',items:{type:'object',additionalProperties:true}},
  } },
  { $id:'SearchItem',type:'object',properties:{uin:nullableText,name:text,status:nullableText,register:nullableText,entityType:nullableText,registeredOn:nullableText,address:nullableText,previousNames:{type:'array',items:text},previousAddresses:{type:'array',items:text},fields:{type:'array',items:{$ref:'Field#'}},text} },
  { $id:'SearchResult',type:'object',properties:{query:text,items:{type:'array',items:{$ref:'SearchItem#'}},page:{type:'integer'},pageSize:{type:'integer'},hasMore:{type:'boolean'},total:{type:['integer','null']},retrievedAt:text,source:text,sourcePagesFetched:{type:'integer'},warnings:{type:'array',items:text}} },
  { $id:'RegistryDocument',type:'object',properties:{kind:{enum:['incorporationCertificate','standardExtract']},status:{enum:['available','unavailable','restricted','error']},filename:nullableText,mimeType:{const:'application/pdf'},encoding:{const:'base64'},contentBase64:nullableText,sizeBytes:{type:['integer','null']},sha256:nullableText,retrievedAt:nullableText,warnings:{type:'array',items:text}} },
  { $id:'DocumentsResult',type:'object',properties:{uin:text,name:text,documents:{type:'array',items:{$ref:'RegistryDocument#'}},complete:{type:'boolean'},warnings:{type:'array',items:text},retrievedAt:text,source:text} },
  { $id:'EntityResult',type:'object',properties:{uin:text,name:text,status:nullableText,entityType:nullableText,availableSections:{type:'array',items:{type:'object',properties:{key:text,label:text}}},sections:{type:'object',additionalProperties:{$ref:'Section#'}},complete:{type:'boolean'},warnings:{type:'array',items:text},retrievedAt:text,source:text} },
  { $id:'Error',type:'object',properties:{error:{type:'object',properties:{code:text,message:text,retryable:{type:'boolean'},requestId:text}}} },
];
export const envelope = (type: string) => ({type:'object',properties:{data:{$ref:`${type}#`},meta:{type:'object',properties:{cache:{enum:['hit','miss','coalesced']},ageMs:{type:'number'},durationMs:{type:'number'}}}}});
export const errorResponses = Object.fromEntries([400,401,404,429,502,503,504].map(status => [status,{$ref:'Error#'}]));
