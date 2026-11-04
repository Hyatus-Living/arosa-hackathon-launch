// WebGL context-loss recovery for the walkthrough canvas. A lost context leaves a
// permanently black canvas unless the loss is acknowledged: calling preventDefault
// on webglcontextlost is what allows the browser to later fire webglcontextrestored.
// If no restore arrives, the caller remounts the canvas for a fresh context.
export function attachContextRecovery(canvas,{onLost,onRestored}){
  let lost=false;
  const lostHandler=event=>{
    event.preventDefault();
    if(lost)return;
    lost=true;
    onLost();
  };
  const restoredHandler=()=>{
    if(!lost)return;
    lost=false;
    onRestored();
  };
  canvas.addEventListener('webglcontextlost',lostHandler);
  canvas.addEventListener('webglcontextrestored',restoredHandler);
  return ()=>{
    canvas.removeEventListener('webglcontextlost',lostHandler);
    canvas.removeEventListener('webglcontextrestored',restoredHandler);
  };
}
