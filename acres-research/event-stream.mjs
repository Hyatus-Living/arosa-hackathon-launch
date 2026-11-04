import {setImmediate as yieldTurn} from 'node:timers/promises';

// Notifications carry no buffered payloads. SQLite is the queue, read in bounded
// pages, so a slow client cannot accumulate an unbounded live-event array.
export function streamEvents({res,after=0,readPage,subscribe,allowed,finished=()=>false,onClose=()=>{},
  terminal=()=>false,pageSize=32,drainTimeoutMs=10000,heartbeatMs=15000}) {
  let cursor=after,closed=false,pumping=false,requested=false,heartbeat=false,releaseDrain=null;
  const cleanup=()=>{
    if(closed)return;
    closed=true;clearInterval(timer);unsubscribe();releaseDrain?.(false);onClose(cursor);
  };
  const stop=()=>{cleanup();res.end();};
  async function write(frame) {
    if(closed)return false;
    if(res.write(frame))return true;
    return new Promise(resolve=>{
      const settle=ok=>{clearTimeout(timeout);res.off('drain',drained);releaseDrain=null;resolve(ok);};
      const drained=()=>settle(true);
      const timeout=setTimeout(()=>{settle(false);cleanup();res.destroy();},drainTimeoutMs);
      releaseDrain=settle;res.once('drain',drained);
    });
  }
  async function pump() {
    if(pumping||closed)return;
    pumping=true;
    try {
      do {
        requested=false;
        if(!allowed()){stop();return;}
        const page=readPage(cursor,pageSize);
        for(const event of page) {
          if(closed)return;
          if(!allowed()){stop();return;}
          if(!await write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`))return;
          cursor=event.seq;
          if(terminal(event)){stop();return;}
        }
        if(page.length===pageSize){requested=true;await yieldTurn();}
        else if(!requested&&finished()){stop();return;}
        if(heartbeat&&!closed){heartbeat=false;if(!await write(': keepalive\n\n'))return;}
      }while(requested&&!closed);
    }catch{cleanup();res.destroy();}
    finally{pumping=false;}
  }
  const wake=()=>{requested=true;void pump();};
  const unsubscribe=subscribe(wake);
  const timer=setInterval(()=>{heartbeat=true;wake();},heartbeatMs);
  res.once('close',cleanup);
  res.writeHead(200,{'content-type':'text/event-stream','connection':'keep-alive','x-accel-buffering':'no'});
  // The initial comment is small; every data frame respects drain before another write.
  res.write(': connected\n\n');
  wake();
  return stop;
}
