// Small ASCII PDF input for extraction tests. Returns bytes, not a rendered artifact.
export function pdfDocument(pages) {
  const escape=text=>text.replace(/([\\()])/g,'\\$1');
  const objects=['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_,i)=>`${4+i*2} 0 R`).join(' ')}] >>`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for(const lines of pages){
    const content=lines.length?'BT /F1 10 Tf 72 720 Td '+lines.map((line,i)=>(i?'0 -14 Td ':'')+`(${escape(line)}) Tj`).join('\n')+' ET':'';
    const contentId=objects.length+2;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  let pdf='%PDF-1.4\n';const offsets=[0];
  objects.forEach((object,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${object}\nendobj\n`;});
  const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('');
  return Buffer.from(pdf+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

export const municipalPdf=()=>pdfDocument([
  ['FIRST-PAGE-GUIDANCE',...Array(8).fill('A public source paragraph on the first physical page.')],
  [],
  ['APPENDIX-REVIEW on physical page three.','Printed page 1 of 2.',...Array(8).fill('A separate appendix paragraph for source verification.')],
]);
