import {useEffect,useRef,useState} from 'react';
import {Upload,ScanSearch,X} from 'lucide-react';
import {modelInput,geometryKey,downloadModelReport} from '../public/model-intake.js';

function Heatmap({report}) {
  const xs=report.points.map(p=>p.x),ys=report.points.map(p=>p.y);
  const x=Math.min(...xs),y=Math.min(...ys),width=Math.max(...xs)-x,height=Math.max(...ys)-y;
  const span=Math.max(width,height,.1),r=span/220;
  return <figure className="model-fit-map"><svg viewBox={`${x-span*.03} ${-y-height-span*.03} ${Math.max(width,span*.02)+span*.06} ${Math.max(height,span*.02)+span*.06}`} role="img" aria-label="Top-down scan points colored by distance from the model">
    {report.points.map((p,i)=>p.distance<=report.toleranceMetres?<circle key={i} cx={p.x} cy={-p.y} r={r} className="fit-near"><title>{(p.distance*1000).toFixed(1)} mm from model</title></circle>:<rect key={i} x={p.x-r} y={-p.y-r} width={r*2} height={r*2} className="fit-far"><title>{(p.distance*1000).toFixed(1)} mm from model</title></rect>)}
  </svg><figcaption>Top view, all levels. <span className="fit-near-key">● Within tolerance</span> · <span className="fit-far-key">■ Outside tolerance</span></figcaption></figure>;
}

export function ModelIntake({projectId,plan,onImport,initialFile,onFileConsumed}) {
  const [mode,setMode]=useState(null),[file,setFile]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [candidate,setCandidate]=useState(null),[check,setCheck]=useState(null),[units,setUnits]=useState('m'),[tolerance,setTolerance]=useState('25');
  const titleRef=useRef(null),resultRef=useRef(null),requestRef=useRef(null),ifcButton=useRef(null),scanButton=useRef(null);
  useEffect(()=>()=>requestRef.current?.abort(),[]);
  useEffect(()=>{if(mode)titleRef.current?.focus();},[mode]);
  useEffect(()=>{if(candidate||check){resultRef.current?.scrollIntoView({block:'start'});resultRef.current?.focus({preventScroll:true});}},[candidate,check]);
  useEffect(()=>{if(initialFile){setMode('ifc');setFile(initialFile);setCandidate(null);setError('');onFileConsumed();}},[initialFile,onFileConsumed]);
  function open(next){setMode(next);setFile(null);setCandidate(null);setCheck(null);setError('');}
  function close(){requestRef.current?.abort();setBusy(false);setMode(null);(mode==='ifc'?ifcButton:scanButton).current?.focus();}
  async function submit(event){
    event?.preventDefault();if(busy)return;setError('');setBusy(true);
    const controller=new AbortController();requestRef.current=controller;
    const geometry=geometryKey(plan);
    try {
      const result=await modelInput({fetch,projectId,operation:mode==='ifc'?'import-ifc':'validate-scan',file,
        ...(mode==='scan'?{plan,units,tolerance:Number(tolerance)/1000}:{}),signal:controller.signal});
      if(controller.signal.aborted)return;
      if(mode==='ifc')setCandidate(result);else setCheck({report:result,geometry});
    }catch(e){if(!controller.signal.aborted)setError(e.message);}
    finally{if(requestRef.current===controller)setBusy(false);}
  }
  const stale=check&&check.geometry!==geometryKey(plan);
  const hasResult=mode==='ifc'?!!candidate:!!check;
  return <div className="model-intake">
    <div className="model-intake-actions">
      <button ref={ifcButton} type="button" disabled={busy} onClick={()=>open('ifc')} aria-expanded={mode==='ifc'}><Upload aria-hidden="true"/>Import IFC</button>
      <button ref={scanButton} type="button" disabled={busy||!plan?.walls.length} onClick={()=>open('scan')} aria-expanded={mode==='scan'}><ScanSearch aria-hidden="true"/>Check scan</button>
    </div>
    {mode&&<section className={`model-intake-panel${hasResult?' is-result':''}`} aria-labelledby="model-intake-title" onKeyDown={e=>{if(e.key==='Escape')close();}}>
      <div className="model-intake-heading"><h3 id="model-intake-title" tabIndex={-1} ref={titleRef}>{mode==='ifc'?'Import an editable model':'Check model fit'}</h3><button type="button" aria-label="Close model intake" onClick={close}><X aria-hidden="true"/></button></div>
      {!hasResult&&<p>{mode==='ifc'?'Import straight walls, levels, doors and windows. Review unsupported elements before replacing the current plan. The original IFC is retained.':'Use a point cloud aligned with the model’s axes and origin. Scan coordinates are converted using the units you choose; points are not automatically registered.'}</p>}
      <form onSubmit={submit} hidden={hasResult}>
        <label>{mode==='ifc'?'IFC file':'Point cloud'}<input key={mode} type="file" accept={mode==='ifc'?'.ifc':'.ply,.las,.laz,.xyz'} disabled={busy} onChange={e=>{setFile(e.target.files[0]??null);setCandidate(null);setError('');}} required={!file}/></label>
        <small>{file?.name||'Choose a file'} · Up to 25 MB{mode==='scan'?' · PLY, LAS, LAZ or XYZ':''}</small>
        {mode==='scan'&&<div className="model-fit-fields"><label>Scan units<select value={units} onChange={e=>setUnits(e.target.value)} disabled={busy}><option value="m">Metres</option><option value="mm">Millimetres</option><option value="ft">Feet</option></select></label><label>Tolerance (mm)<input type="number" min="1" max="1000" step="1" value={tolerance} onChange={e=>setTolerance(e.target.value)} required disabled={busy}/></label></div>}
        <button type="submit" className="plan-primary" disabled={busy||!file||mode==='scan'&&!plan?.walls.length}>{busy?'Processing…':mode==='ifc'?'Review import':'Check scan'}</button>
      </form>
      {error&&<p role="alert" className="model-intake-error">{error}</p>}
      {candidate&&mode==='ifc'&&<div className="model-intake-result" role="region" aria-label="IFC import review">
        <h4 tabIndex={-1} ref={resultRef}>Import review</h4>
        <p>{candidate.report.importedWalls} editable walls · {candidate.report.importedOpenings} openings · {candidate.plan.levels.length} {candidate.plan.levels.length===1?'level':'levels'}</p>
        <p>{candidate.report.derived}</p><p>{candidate.report.coordinates}</p>
        {candidate.report.omitted.length>0&&<details><summary>{candidate.report.omitted.length} elements retained only in the source IFC</summary><ul>{candidate.report.omitted.slice(0,100).map((item,i)=><li key={i}>{item.name||item.type}: {item.reason}</li>)}</ul>{candidate.report.omitted.length>100&&<p>Download the import report for the complete list.</p>}</details>}
        <div className="model-intake-actions"><a href={`/api/projects/${encodeURIComponent(projectId)}/architecture/drawings/${candidate.source.id}`} download={candidate.source.name}>Original IFC</a><button type="button" onClick={()=>downloadModelReport(candidate.report,'ifc-import-report.json')}>Import report</button></div>
        <p>{plan?'Replace the current plan with an unsaved draft. You can undo the replacement or save a new revision.':'Use this model as an unsaved draft, then save a new revision when ready.'}</p>
        <button type="button" className="plan-primary" onClick={()=>{onImport(candidate.plan);close();}}>Use editable model</button>
        <button type="button" onClick={()=>setCandidate(null)}>Choose another IFC</button>
      </div>}
      {check&&mode==='scan'&&<div className="model-intake-result" role="region" aria-label="Scan validation results">
        <h4 tabIndex={-1} ref={resultRef}>Scan results</h4>
        {stale&&<p role="status" className="model-intake-error">The model has changed. Run the check again for current results.</p>}
        <p><strong>{check.report.withinPercent.toFixed(1)}%</strong> of tested points within {check.report.toleranceMetres*1000} mm</p>
        <dl className="model-fit-stats"><div><dt>Median distance</dt><dd>{(check.report.medianMetres*1000).toFixed(1)} mm</dd></div><div><dt>95th percentile</dt><dd>{(check.report.p95Metres*1000).toFixed(1)} mm</dd></div><div><dt>Maximum</dt><dd>{(check.report.maxMetres*1000).toFixed(1)} mm</dd></div></dl>
        <p>{check.report.testedPoints.toLocaleString()} of {check.report.totalPoints.toLocaleString()} points tested{check.report.sampled?' using a uniform sample':''}. Showing up to 2,000 points.</p>
        <Heatmap report={check.report}/><p>{check.report.scope}</p>
        <button type="button" onClick={()=>downloadModelReport(check.report,'scan-validation.json')}>Download validation report</button>
        <div className="model-intake-actions"><button type="button" disabled={busy} onClick={()=>submit()}>{busy?'Processing…':'Run check again'}</button><button type="button" disabled={busy} onClick={()=>setCheck(null)}>Change file or tolerance</button></div>
      </div>}
    </section>}
  </div>;
}
