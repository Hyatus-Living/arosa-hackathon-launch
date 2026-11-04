// Compare the settled detailed view with the interactive view at the same pose.
// A probe with no pixels (or a size mismatch) proves nothing, so it never triggers
// the fallback. Values up to 10/255 read as black on screen; the old <= 5 cutoff let
// a near-black detailed frame through whenever the raster view was only dimly lit
// (total-light ratio then stayed above the .08 branch).
export function isBlackDetail(detail,raster) {
  if(!raster.length||detail.length<raster.length)return false;
  let bright=0,missing=0,detailedLight=0,interactiveLight=0;
  for(let i=0;i<raster.length;i+=4){
    detailedLight+=detail[i]+detail[i+1]+detail[i+2];interactiveLight+=raster[i]+raster[i+1]+raster[i+2];
    if(Math.max(raster[i],raster[i+1],raster[i+2])<64)continue;
    bright++;
    if(Math.max(detail[i],detail[i+1],detail[i+2])<=10)missing++;
  }
  return bright>=raster.length/4*.2 && (missing>=bright*.85 || detailedLight<interactiveLight*.08);
}
