import { AppError } from '../contracts/base.js';
export function apiError(error:unknown):{status:400|401|403|404|409|422|500;body:{error:{code:string;message:string}}} {
  if(!(error instanceof AppError)||error.code==='INTERNAL_CONTRACT')return {status:500,body:{error:{code:'INTERNAL_ERROR',message:'The request could not be completed'}}};
  const status=error.code==='UNAUTHORIZED'?401:error.code==='FORBIDDEN'?403:error.code.endsWith('NOT_FOUND')||error.code==='NOT_FOUND'?404:
    error.code==='UNSUPPORTED_THINKING_LEVEL'||error.code==='UNKNOWN_MODEL'||error.code==='UNKNOWN_PROVIDER'||error.code==='MODEL_UNAVAILABLE'?422:
    error.code==='INVALID_REQUEST'||error.code==='INVALID_CURSOR'?400:409;
  return {status,body:{error:{code:error.code,message:error.message}}};
}
