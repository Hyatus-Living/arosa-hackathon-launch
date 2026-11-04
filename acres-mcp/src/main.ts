import {loadConfig} from './config.js';
import {createGateway} from './server.js';

try {
  const config=loadConfig(),port=Number(process.env.PORT||8080);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid port.');
  const server=createGateway(config);
  server.listen(port,process.env.HOST||'0.0.0.0',()=>console.log(JSON.stringify({event:'mcp_started',port})));
  const stop=()=>{server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),25000).unref();};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
} catch {
  console.error('Arosa MCP failed to start. Check the required MCP configuration and membership file.');process.exitCode=1;
}
