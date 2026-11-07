import http from 'node:http';
import { loadEnvFile } from 'node:process';
try { loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const { default: worker } = await import('./worker/vercel.js');
const portIndex=process.argv.indexOf('--port');const port=Number(process.env.PORT||(portIndex>=0?process.argv[portIndex+1]:3000));if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid port');http.createServer(async(req,res)=>{try{const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);const out=await worker.fetch(new Request('http://localhost'+req.url,{method:req.method,headers:req.headers,...(body.length?{body}: {})}));res.writeHead(out.status,Object.fromEntries(out.headers));res.end(Buffer.from(await out.arrayBuffer()));}catch(e){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:e.message}))}}).listen(port,'127.0.0.1',()=>console.log('Ready on '+port));
