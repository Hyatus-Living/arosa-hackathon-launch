import React, {useEffect, useRef, useState} from 'react';

const readImage=file=>new Promise((resolve,reject)=>{
  const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Could not read the image.'));reader.readAsDataURL(file);
});
async function post(projectId,operation,body) {
  const response=await fetch(`/api/projects/${encodeURIComponent(projectId)}/architecture/${operation}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();
  if(!response.ok)throw new Error(result.error||'The image request failed.');
  return result;
}
function capture(canvasRef) {
  const canvas=canvasRef.current?.querySelector('.concept-canvas canvas');
  if(!canvas)throw new Error('Open the 3D building model first.');
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('The building model could not be captured.')),5000);
    const done=fn=>value=>{clearTimeout(timer);fn(value);};
    window.dispatchEvent(new CustomEvent('acres:capture-view',{detail:{canvas,resolve:done(resolve),reject:done(reject)}}));
  }).then(readImage);
}
function drawMasks(context,masks,selected) {
  for(const mask of masks.filter(m=>selected.includes(m.id))) {
    const binary=atob(mask.pixels),image=context.createImageData(mask.width,mask.height);
    for(let i=0;i<binary.length;i++)if(binary.charCodeAt(i)){image.data[i*4]=32;image.data[i*4+1]=143;image.data[i*4+2]=104;image.data[i*4+3]=115;}
    const source=document.createElement('canvas');source.width=mask.width;source.height=mask.height;
    source.getContext('2d').putImageData(image,0,0);
    context.drawImage(source,mask.bounds.left,mask.bounds.top,mask.bounds.right-mask.bounds.left,mask.bounds.bottom-mask.bounds.top);
  }
}
async function selectionReference(photo,masks,selected) {
  if(!selected.length)return null;
  const img=new Image();img.src=photo.url;await img.decode();
  const scale=Math.min(1,1600/Math.max(photo.width,photo.height)),canvas=document.createElement('canvas');
  canvas.width=Math.round(photo.width*scale);canvas.height=Math.round(photo.height*scale);
  const context=canvas.getContext('2d');context.scale(scale,scale);context.drawImage(img,0,0);drawMasks(context,masks,selected);
  return canvas.toDataURL('image/jpeg',0.82);
}
function MaskPreview({photo,masks,selected,points,onMark,busy}) {
  const canvas=useRef(null);
  useEffect(()=>{
    const element=canvas.current;if(!element||!photo.width||!photo.height)return;
    element.width=photo.width;element.height=photo.height;
    const context=element.getContext('2d');context.clearRect(0,0,element.width,element.height);
    drawMasks(context,masks,selected);
    for(const point of points){context.beginPath();context.arc(point.x,point.y,Math.max(6,photo.width/150),0,2*Math.PI);context.fillStyle=point.label==='negative'?'#be4636':'#186d48';context.fill();context.strokeStyle='#fff';context.lineWidth=Math.max(2,photo.width/500);context.stroke();}
  },[photo,masks,selected,points]);
  const mark=event=>{const rect=event.currentTarget.getBoundingClientRect();const x=event.clientX?event.clientX-rect.left:rect.width/2,y=event.clientY?event.clientY-rect.top:rect.height/2;onMark(Math.max(0,Math.min(photo.width-1,Math.round(x*photo.width/rect.width))),Math.max(0,Math.min(photo.height-1,Math.round(y*photo.height/rect.height))));};
  return <button type="button" className="visual-photo" disabled={busy} aria-label="Mark a point on the site photo" onClick={mark}><img src={photo.url} alt="Site photo" /><canvas ref={canvas} aria-hidden="true" /></button>;
}
export function VisualWorkbench({projectId,concept,canvasRef,canCapture,photoTilesVisible}) {
  const [photo,setPhoto]=useState(null),[subject,setSubject]=useState('building'),[goal,setGoal]=useState('adu'),[note,setNote]=useState('');
  const [masks,setMasks]=useState([]),[selected,setSelected]=useState([]),[image,setImage]=useState(null),[provenance,setProvenance]=useState(null),[busy,setBusy]=useState(''),[error,setError]=useState(''),[searched,setSearched]=useState(false);
  const [points,setPoints]=useState([]),[pointMode,setPointMode]=useState('positive');
  const [billing,setBilling]=useState(null);
  useEffect(()=>{let active=true;fetch('/api/wallet').then(async response=>{if(!response.ok)throw new Error('Pricing is unavailable.');return response.json();}).then(value=>{if(active)setBilling(value);}).catch(()=>{if(active)setBilling({error:true});});return()=>{active=false;};},[]);
  const rate=operation=>billing?.enabled?billing.policy?.rates?.[operation]:null;
  const available=operation=>billing&&!billing.error&&(!billing.enabled||rate(operation)?.mode==='estimated_call');
  const quote=operation=>{const value=rate(operation);return value?{version:value.version,amountMicros:value.amountMicros,reserveMicros:value.reserveMicros}:null;};
  const usd=micros=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:6}).format(micros/1e6);
  const price=operation=>{const value=rate(operation);return value?`${usd(value.amountMicros)} per request; ${usd(value.reserveMicros)} held first.`:'Pricing is unavailable.';};
  async function choose(event) {
    const file=event.target.files?.[0];event.target.value='';if(!file)return;
    setError('');setPhoto(null);setMasks([]);setSelected([]);setImage(null);setProvenance(null);setSearched(false);setPoints([]);
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>5*1024*1024){setError('Choose a PNG, JPEG or WebP photo up to 5 MB.');return;}
    try {
      const url=await readImage(file),img=new Image();img.src=url;await img.decode();
      if(img.naturalWidth*img.naturalHeight>16_000_000)throw new Error('Choose a photo under 16 megapixels.');
      setPhoto({url,width:img.naturalWidth,height:img.naturalHeight});
    } catch(e){setError(e.message||'Could not read the photo.');}
  }
  async function segment(usePoints=false) {
    setBusy('segment');setError('');setSearched(false);
    try{const result=await post(projectId,'visual-segment',{photo:photo.url,subject,pricing:quote('meta_visual_segment'),...(usePoints?{points,size:{width:photo.width,height:photo.height}}:{})});setMasks(result.masks);setSelected(result.masks.map(m=>m.id));setSearched(true);}
    catch(e){setError(e.message);}finally{setBusy('');}
  }
  async function illustrate() {
    setBusy('illustrate');setError('');setImage(null);setProvenance(null);
    try{
      const modelImage=await capture(canvasRef);
      const selectionImage=await selectionReference(photo,masks,selected);
      const result=await post(projectId,'visual-illustrate',{photo:photo.url,modelImage,selectionImage,goal,note,conceptId:concept.id,conceptVersion:concept.version??null,pricing:quote('meta_visual_illustrate')});
      setImage(result.image);setProvenance(result.provenance??null);
    } catch(e){setError(e.message);}finally{setBusy('');}
  }
  return <details className="visual-workbench"><summary>Explore a housing idea with your photo</summary><div className="visual-body">
    <p>Use a site photo with this building model to explore a backyard home, addition or small housing project. Your photo and model view are sent to Meta when you choose an action.</p>
    {billing?.enabled && <p>SAM: {price('meta_visual_segment')} Illustration: {price('meta_visual_illustrate')}</p>}
    {billing?.error && <p role="alert">Pricing is unavailable. Reload to try again.</p>}
    <label>Site photo <input type="file" accept="image/png,image/jpeg,image/webp" disabled={!!busy} onChange={choose} /></label>
    {photo && <><MaskPreview photo={photo} masks={masks} selected={selected} points={points} busy={!!busy} onMark={(x,y)=>setPoints(p=>p.length<30?[...p,{x,y,label:pointMode}]:p)}/><div className="visual-controls">
      <label>Find in photo <input value={subject} maxLength={80} disabled={!!busy} onChange={e=>setSubject(e.target.value)} /></label>
      <button type="button" onClick={()=>segment(false)} disabled={!!busy||!subject.trim()||!available('meta_visual_segment')}>{busy==='segment'?'Finding…':'Find with SAM'}</button>
    </div>{searched && (masks.length ? <><fieldset><legend>Selected areas for the illustration</legend>{masks.map((mask,i)=><label key={mask.id}><input type="checkbox" checked={selected.includes(mask.id)} onChange={e=>setSelected(e.target.checked?[...selected,mask.id]:selected.filter(id=>id!==mask.id))} /> Object {i+1}{mask.confidence!=null?` (${Math.round(mask.confidence*100)}% match)`:''}</label>)}</fieldset><p>The highlighted areas guide the illustration, but exact placement may vary.</p></> : <p>No matching objects found. Try another description.</p>)}
    <div className="visual-controls"><label>Mark points on the photo <select value={pointMode} disabled={!!busy} onChange={e=>setPointMode(e.target.value)}><option value="positive">Include this area</option><option value="negative">Exclude this area</option></select></label><button type="button" disabled={!!busy||!points.length||!available('meta_visual_segment')} onClick={()=>segment(true)}>Refine selection</button><button type="button" disabled={!!busy||!points.length} onClick={()=>setPoints([])}>Clear points</button></div>
    <div className="visual-controls"><label>Housing idea <select value={goal} disabled={!!busy} onChange={e=>setGoal(e.target.value)}><option value="adu">Backyard home or ADU</option><option value="addition">Home addition</option><option value="infill">Small infill housing</option></select></label>
    <label>Design notes <input value={note} maxLength={500} disabled={!!busy} onChange={e=>setNote(e.target.value)} placeholder="Optional" /></label></div>
    <button type="button" onClick={illustrate} disabled={!!busy||!canCapture||!available('meta_visual_illustrate')}>{busy==='illustrate'?'Creating illustration…':'Create illustration with Muse Image'}</button>
    {!canCapture && <p>{photoTilesVisible?'Turn off Photo tiles to use the building model as a reference.':'Open the 3D view and wait for the building model to load.'}</p>}
    {image && <figure><img src={image} alt="AI-generated conceptual housing illustration" /><figcaption>Conceptual illustration. It may differ from the editable building model and does not establish zoning compliance. Download it to keep it.{provenance && <> Made with {provenance.model} from photo {provenance.photoSha256.slice(0,8)}, model view {provenance.modelImageSha256.slice(0,8)}{provenance.selectionImageSha256?`, selection ${provenance.selectionImageSha256.slice(0,8)}`:''}{provenance.conceptVersion!=null?`, concept version ${provenance.conceptVersion}`:''}; illustration {provenance.imageSha256.slice(0,8)}.</>}</figcaption><a href={image} download="housing-concept.png">Download illustration</a>{provenance && <> <a href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(provenance,null,2))}`} download="housing-concept-provenance.json">Download provenance</a></>}</figure>}
    </>}
    {error && <p role="alert">{error}</p>}
  </div></details>;
}
