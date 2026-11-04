import express from 'express';

export const isModelInputRequest = req => req.method==='POST' && /^\/api\/projects\/[^/]+\/architecture\/(import-ifc|validate-scan|visual-segment|visual-illustrate)$/.test(req.path);

// Register after authentication. The global JSON parser skips these paths so unauthenticated
// requests are rejected before reading a large file. 36 MB allows a 25 MB base64 file and plan.
export function mountModelInputProxy(app,proxy) {
  const json=express.json({limit:'36mb'});
  for(const operation of ['import-ifc','validate-scan','visual-segment','visual-illustrate']) {
    app.post(`/api/projects/:id/architecture/${operation}`,json,(req,res)=>
      proxy(req,res,`/projects/${encodeURIComponent(req.params.id)}/architecture/${operation}`,req.body));
  }
}
