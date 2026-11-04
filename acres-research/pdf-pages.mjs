import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';

export const PDF_EXTRACTOR='pdf-pages-v1';

export function extractPdfPages(raw) {
  const dir=mkdtempSync(join(tmpdir(),'acres-pdf-'));
  try {
    const path=join(dir,'source.pdf');writeFileSync(path,raw,{mode:0o600});
    const output=execFileSync('pdftotext',['-layout',path,'-'],{encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});
    const pages=output.split('\f');if(pages.at(-1)==='')pages.pop();
    let offset=0;const pdfPages=pages.map((text,index)=>{const page={page:index+1,start:offset,end:offset+text.length};offset+=text.length+2;return page;});
    return {text:output.replace(/\f/g,'\n\n'),publishedAt:null,pdfPages};
  } finally {rmSync(dir,{recursive:true,force:true});}
}

const validPage=page=>{
  if(!Number.isSafeInteger(page)||page<1)throw new Error('PDF page must be a positive whole number, starting at 1.');
  return page;
};
export const isPdfUrl=url=>new URL(url).pathname.toLowerCase().endsWith('.pdf');
export function requestedPdfPage(url,page) {
  const params=[...new URLSearchParams(new URL(url).hash.slice(1).replace(/#/g,'&'))];
  const value=params.filter(([key])=>key.toLowerCase()==='page').at(-1)?.[1];
  const fragment=value===undefined?undefined:validPage(/^\d+$/.test(value)?Number(value):NaN);
  if(page!==undefined)validPage(page);
  if(page!==undefined&&fragment!==undefined&&page!==fragment)throw new Error('The requested PDF page conflicts with the URL page fragment.');
  return page??fragment;
}
export function pdfPageUrl(url,page) {const out=new URL(url);out.hash=`page=${page}`;return out.href;}
export const pdfPageTitle=(title,page,count)=>`PDF page ${page} of ${count}: ${title}`;

export function selectPdfPage(document,page) {
  validPage(page);
  if(!document.pdfPages)throw new Error('This source does not have PDF page metadata.');
  const range=document.pdfPages[page-1];
  if(!range)throw new Error(`PDF page ${page} is outside this ${document.pdfPages.length}-page document.`);
  const text=document.text.slice(range.start,range.end).trim();
  if(!text)throw new Error(`PDF page ${page} has no extractable text; it may be blank or scanned.`);
  return {...document,url:pdfPageUrl(document.url,page),title:pdfPageTitle(document.title,page,document.pdfPages.length),text,pdf:{page,pageCount:document.pdfPages.length,extractor:PDF_EXTRACTOR}};
}
