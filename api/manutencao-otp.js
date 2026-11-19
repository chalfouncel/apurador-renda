export default async function handler(req,res){
  res.setHeader("Cache-Control","no-store");
  if(req.method!=="POST")return res.status(405).json({error:"Use POST."});
  try{
    const site=new URL(process.env.VISTORIA_URL);
    if(site.protocol!=="https:")throw Error();
    const r=await fetch(new URL("/api/manutencao-otp",site.origin),{method:"POST",redirect:"error",signal:AbortSignal.timeout(25000)});
    if(!r.ok||!(await r.json()).success)throw Error();
    return res.status(200).json({success:true});
  }catch{return res.status(503).json({error:"Falha ao solicitar o código à Vistoria. Confira VISTORIA_URL e tente novamente."});}
}
