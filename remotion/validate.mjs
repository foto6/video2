// Model code is parsed here, never evaluated in Node. Only a pure frame component
// is compiled into a fresh, credential-free render browser.
import {parse} from '@babel/parser';
import traverseImport from '@babel/traverse';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const traverse = traverseImport.default ?? traverseImport;
const inputs = new Set(['frame','fps','width','height','durationInFrames','palette']);
const globals = new Set(['Math','interpolate','spring','clamp','range','undefined']);
const tags = new Set(['div','span','p','strong','br','svg','g','path','rect','circle','ellipse','line','polyline','polygon','text','tspan','defs','linearGradient','radialGradient','stop','clipPath','mask','filter','feGaussianBlur','feDropShadow','feColorMatrix','feBlend','feComposite','feMerge','feMergeNode']);
const methods = new Set(['abs','acos','asin','atan','atan2','ceil','cos','exp','floor','hypot','log','max','min','pow','round','sign','sin','sqrt','tan','trunc','map','slice','join','toFixed']);
const forbidden = new Set(['constructor','prototype','__proto__','call','apply','bind','caller','callee','arguments','dangerouslySetInnerHTML','ref','href','src','srcSet','innerHTML','outerHTML','backgroundImage','cssText']);
const nodes = new Set(['Program','FunctionDeclaration','Identifier','ObjectPattern','ObjectProperty','ObjectExpression','VariableDeclaration','VariableDeclarator','ArrayExpression','ArrowFunctionExpression','BlockStatement','ReturnStatement','NumericLiteral','StringLiteral','BooleanLiteral','NullLiteral','BinaryExpression','LogicalExpression','UnaryExpression','ConditionalExpression','MemberExpression','CallExpression','ExpressionStatement','IfStatement','TemplateLiteral','TemplateElement','JSXElement','JSXOpeningElement','JSXClosingElement','JSXIdentifier','JSXAttribute','JSXExpressionContainer','JSXText','JSXFragment','JSXOpeningFragment','JSXClosingFragment','JSXEmptyExpression']);
const fail = reason => {throw Error('Animation code: '+reason);};
const externalResource=value=>/(?:https?:|file:|javascript:|data:|url\s*\()/i.test(value.replace(/url\(#[A-Za-z0-9_-]+\)/g,''));
export function validateSource(source) {
  if(typeof source!=='string'||source.length<40||source.length>18000) fail('source must contain 40–18000 characters');
  let ast;try {ast=parse(source,{sourceType:'script',plugins:['jsx']});}catch(e){fail(e.message);}
  const top=ast.program.body;
  if(top.length!==1||top[0].type!=='FunctionDeclaration'||top[0].id?.name!=='Scene') fail('return exactly function Scene({...}) { ... }, with no imports/exports');
  const params=top[0].params;
  if(params.length!==1||params[0].type!=='ObjectPattern'||params[0].properties.some(p=>p.type!=='ObjectProperty'||p.computed||!inputs.has(p.key.name)||p.value.type!=='Identifier'||p.value.name!==p.key.name)) fail('destructure only frame, fps, width, height, durationInFrames, palette');
  let count=0, animated=false;
  traverse(ast,{
    enter(p){
      const n=p.node;if(++count>7000)fail('component is too large');
      if(!nodes.has(n.type))fail('unsupported syntax '+n.type);
      if(n.async||n.generator)fail('asynchronous/generator code is unavailable');
      if(n.type==='VariableDeclaration'&&n.kind!=='const')fail('use const bindings and pure expressions');
      if(n.type==='ObjectProperty'&&(n.computed||forbidden.has(n.key.name??n.key.value)))fail('unsupported object property');
      if(n.type==='MemberExpression'&&(n.computed||n.property.type!=='Identifier'||forbidden.has(n.property.name)||n.property.name.startsWith('_')||n.property.name==='random'))fail('computed/prototype/random property access is unavailable');
      if(n.type==='UnaryExpression'&&!['!','+','-'].includes(n.operator))fail('unsupported unary operation');
      if(n.type==='BinaryExpression'&&!['+','-','*','/','%','**','<','<=','>','>=','===','!==','==','!='].includes(n.operator))fail('unsupported binary operation');
      if(n.type==='CallExpression'){
        if(n.callee.type==='MemberExpression'){
          if(!methods.has(n.callee.property.name))fail('unsupported method '+n.callee.property.name);
          if(n.callee.object.type==='Identifier'&&n.callee.object.name==='Math'&&!methods.has(n.callee.property.name))fail('unsupported Math operation');
        }else if(n.callee.type!=='Identifier'||n.callee.name==='Scene')fail('unsupported call');
      }
      if(n.type==='StringLiteral'&&externalResource(n.value))fail('resource URLs are unavailable in frame code');
      if(n.type==='TemplateElement'&&externalResource(n.value.raw))fail('resource URLs are unavailable in frame code');
      if(n.type==='JSXOpeningElement'){
        const local=n.name.type==='JSXIdentifier'&&/^[A-Z]/.test(n.name.name)&&n.name.name!=='Scene'&&p.scope.getBinding(n.name.name);
        if(n.name.type!=='JSXIdentifier'||(!tags.has(n.name.name)&&!local))fail('unsupported visual element');
        for(const a of n.attributes)if(a.type!=='JSXAttribute'||a.name.type!=='JSXIdentifier'||forbidden.has(a.name.name)||/^on/i.test(a.name.name))fail('unsupported visual attribute');
      }
    },
    ReferencedIdentifier(p){
      if(['frame','fps','durationInFrames'].includes(p.node.name))animated=true;
      if(!p.scope.getBinding(p.node.name)&&!globals.has(p.node.name))fail('unknown global '+p.node.name);
    },
    BindingIdentifier(p){if(globals.has(p.node.name))fail('reserved binding '+p.node.name);}
  });
  if(!animated)fail('animation must depend on frame timing');
  return {version:'animation-code.v1',nodes:count,source_characters:source.length};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{const value=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));const scenes=value.scenes??[value];process.stdout.write(JSON.stringify(scenes.map(s=>({beat_id:s.beat_id,...validateSource(s.source)})))+'\n');}
  catch(e){process.stderr.write(e.message+'\n');process.exitCode=1;}
}
