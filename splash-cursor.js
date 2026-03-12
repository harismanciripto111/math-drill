'use strict';

(function () {
  function pointerPrototype() {
    this.id = -1;
    this.texcoordX = 0;
    this.texcoordY = 0;
    this.prevTexcoordX = 0;
    this.prevTexcoordY = 0;
    this.deltaX = 0;
    this.deltaY = 0;
    this.down = false;
    this.moved = false;
    this.color = [0, 0, 0];
  }

  var config = {
    SIM_RESOLUTION: 128,
    DYE_RESOLUTION: 1024,
    CAPTURE_RESOLUTION: 512,
    DENSITY_DISSIPATION: 1,
    VELOCITY_DISSIPATION: 0.2,
    PRESSURE: 0.8,
    PRESSURE_ITERATIONS: 20,
    CURL: 30,
    SPLAT_RADIUS: 0.25,
    SPLAT_FORCE: 6000,
    SHADING: true,
    COLOR_UPDATE_SPEED: 10,
    PAUSED: false,
    BACK_COLOR: { r: 0, g: 0, b: 0 },
    TRANSPARENT: true,
  };

  var pointers = [new pointerPrototype()];

  var canvas = document.createElement('canvas');
  canvas.id = 'splash-canvas';
  // Force canvas behind everything via inline styles — cannot be overridden by stacking context
  canvas.style.cssText = [
    'position:fixed',
    'top:0',
    'left:0',
    'width:100%',
    'height:100%',
    'z-index:-1',
    'pointer-events:none',
    'display:block',
  ].join(';');
  document.body.insertBefore(canvas, document.body.firstChild);

  var gl, ext;

  function getWebGLContext(c) {
    var params = { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false };
    var ctx = c.getContext('webgl2', params);
    var isWebGL2 = !!ctx;
    if (!isWebGL2) ctx = c.getContext('webgl', params) || c.getContext('experimental-webgl', params);
    var halfFloat, supportLinearFiltering;
    if (isWebGL2) {
      ctx.getExtension('EXT_color_buffer_float');
      supportLinearFiltering = ctx.getExtension('OES_texture_float_linear');
    } else {
      halfFloat = ctx.getExtension('OES_texture_half_float');
      supportLinearFiltering = ctx.getExtension('OES_texture_half_float_linear');
    }
    ctx.clearColor(0, 0, 0, 0);
    var halfFloatTexType = isWebGL2 ? ctx.HALF_FLOAT : (halfFloat ? halfFloat.HALF_FLOAT_OES : null);
    var formatRGBA, formatRG, formatR;
    if (isWebGL2) {
      formatRGBA = getSupportedFormat(ctx, ctx.RGBA16F, ctx.RGBA, halfFloatTexType);
      formatRG   = getSupportedFormat(ctx, ctx.RG16F,   ctx.RG,   halfFloatTexType);
      formatR    = getSupportedFormat(ctx, ctx.R16F,    ctx.RED,  halfFloatTexType);
    } else {
      formatRGBA = getSupportedFormat(ctx, ctx.RGBA, ctx.RGBA, halfFloatTexType);
      formatRG   = getSupportedFormat(ctx, ctx.RGBA, ctx.RGBA, halfFloatTexType);
      formatR    = getSupportedFormat(ctx, ctx.RGBA, ctx.RGBA, halfFloatTexType);
    }
    return { gl: ctx, ext: { formatRGBA, formatRG, formatR, halfFloatTexType, supportLinearFiltering } };
  }

  function getSupportedFormat(ctx, internalFormat, format, type) {
    if (!supportRenderTextureFormat(ctx, internalFormat, format, type)) {
      switch (internalFormat) {
        case ctx.R16F:    return getSupportedFormat(ctx, ctx.RG16F,   ctx.RG,   type);
        case ctx.RG16F:   return getSupportedFormat(ctx, ctx.RGBA16F, ctx.RGBA, type);
        default: return null;
      }
    }
    return { internalFormat, format };
  }

  function supportRenderTextureFormat(ctx, internalFormat, format, type) {
    var texture = ctx.createTexture();
    ctx.bindTexture(ctx.TEXTURE_2D, texture);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, ctx.NEAREST);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MAG_FILTER, ctx.NEAREST);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_S, ctx.CLAMP_TO_EDGE);
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_T, ctx.CLAMP_TO_EDGE);
    ctx.texImage2D(ctx.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);
    var fbo = ctx.createFramebuffer();
    ctx.bindFramebuffer(ctx.FRAMEBUFFER, fbo);
    ctx.framebufferTexture2D(ctx.FRAMEBUFFER, ctx.COLOR_ATTACHMENT0, ctx.TEXTURE_2D, texture, 0);
    return ctx.checkFramebufferStatus(ctx.FRAMEBUFFER) === ctx.FRAMEBUFFER_COMPLETE;
  }

  var _wgl = getWebGLContext(canvas);
  gl = _wgl.gl; ext = _wgl.ext;

  if (!gl) { console.warn('SplashCursor: WebGL not supported'); return; }

  // ── Shader sources ──────────────────────────────────────────────────────────

  var baseVertSrc = `precision highp float;attribute vec2 aPosition;varying vec2 vUv;varying vec2 vL;varying vec2 vR;varying vec2 vT;varying vec2 vB;uniform vec2 texelSize;void main(){vUv=aPosition*0.5+0.5;vL=vUv-vec2(texelSize.x,0.0);vR=vUv+vec2(texelSize.x,0.0);vT=vUv+vec2(0.0,texelSize.y);vB=vUv-vec2(0.0,texelSize.y);gl_Position=vec4(aPosition,0.0,1.0);}`;
  var copyFrag    = `precision mediump float;precision mediump sampler2D;varying highp vec2 vUv;uniform sampler2D uTexture;void main(){gl_FragColor=texture2D(uTexture,vUv);}`;
  var clearFrag   = `precision mediump float;precision mediump sampler2D;varying highp vec2 vUv;uniform sampler2D uTexture;uniform float value;void main(){gl_FragColor=value*texture2D(uTexture,vUv);}`;
  var splatFrag   = `precision highp float;precision highp sampler2D;varying vec2 vUv;uniform sampler2D uTarget;uniform float aspectRatio;uniform vec3 color;uniform vec2 point;uniform float radius;void main(){vec2 p=vUv-point.xy;p.x*=aspectRatio;vec3 splat=exp(-dot(p,p)/radius)*color;vec3 base=texture2D(uTarget,vUv).xyz;gl_FragColor=vec4(base+splat,1.0);}`;
  var advectionFrag=`precision highp float;precision highp sampler2D;varying vec2 vUv;uniform sampler2D uVelocity;uniform sampler2D uSource;uniform vec2 texelSize;uniform vec2 dyeTexelSize;uniform float dt;uniform float dissipation;vec4 bilerp(sampler2D sam,vec2 uv,vec2 tSize){vec2 st=uv/tSize-0.5;vec2 iuv=floor(st);vec2 fuv=fract(st);vec4 a=texture2D(sam,(iuv+vec2(0.5,0.5))*tSize);vec4 b=texture2D(sam,(iuv+vec2(1.5,0.5))*tSize);vec4 c=texture2D(sam,(iuv+vec2(0.5,1.5))*tSize);vec4 d=texture2D(sam,(iuv+vec2(1.5,1.5))*tSize);return mix(mix(a,b,fuv.x),mix(c,d,fuv.x),fuv.y);}void main(){vec2 coord=vUv-dt*bilerp(uVelocity,vUv,texelSize).xy*texelSize;vec4 result=bilerp(uSource,coord,dyeTexelSize);float decay=1.0+dissipation*dt;gl_FragColor=result/decay;}`;
  var divergenceFrag=`precision mediump float;precision mediump sampler2D;varying highp vec2 vUv;varying highp vec2 vL;varying highp vec2 vR;varying highp vec2 vT;varying highp vec2 vB;uniform sampler2D uVelocity;void main(){float L=texture2D(uVelocity,vL).x;float R=texture2D(uVelocity,vR).x;float T=texture2D(uVelocity,vT).y;float B=texture2D(uVelocity,vB).y;vec2 C=texture2D(uVelocity,vUv).xy;if(vL.x<0.0){C.x=L;}if(vR.x>1.0){C.x=-R;}if(vT.y>1.0){C.y=T;}if(vB.y<0.0){C.y=-B;}float div=0.5*(R-L+T-B);gl_FragColor=vec4(div,0.0,0.0,1.0);}`;
  var curlFrag    = `precision mediump float;precision mediump sampler2D;varying highp vec2 vUv;varying highp vec2 vL;varying highp vec2 vR;varying highp vec2 vT;varying highp vec2 vB;uniform sampler2D uVelocity;void main(){float L=texture2D(uVelocity,vL).y;float R=texture2D(uVelocity,vR).y;float T=texture2D(uVelocity,vT).x;float B=texture2D(uVelocity,vB).x;float vorticity=R-L-T+B;gl_FragColor=vec4(0.5*vorticity,0.0,0.0,1.0);}`;
  var vorticityFrag=`precision highp float;precision highp sampler2D;varying vec2 vUv;varying vec2 vL;varying vec2 vR;varying vec2 vT;varying vec2 vB;uniform sampler2D uVelocity;uniform sampler2D uCurl;uniform float curl;uniform float dt;void main(){float L=texture2D(uCurl,vL).x;float R=texture2D(uCurl,vR).x;float T=texture2D(uCurl,vT).x;float B=texture2D(uCurl,vB).x;float C=texture2D(uCurl,vUv).x;vec2 force=0.5*vec2(abs(T)-abs(B),abs(R)-abs(L));force/=length(force)+0.0001;force*=curl*C;force.y*=-1.0;vec2 velocity=texture2D(uVelocity,vUv).xy;velocity+=force*dt;velocity=clamp(velocity,-1000.0,1000.0);gl_FragColor=vec4(velocity,0.0,1.0);}`;
  var pressureFrag=`precision mediump float;precision mediump sampler2D;varying highp vec2 vUv;varying highp vec2 vL;varying highp vec2 vR;varying highp vec2 vT;varying highp vec2 vB;uniform sampler2D uPressure;uniform sampler2D uDivergence;void main(){float L=texture2D(uPressure,vL).x;float R=texture2D(uPressure,vR).x;float T=texture2D(uPressure,vT).x;float B=texture2D(uPressure,vB).x;float C=texture2D(uPressure,vUv).x;float divergence=texture2D(uDivergence,vUv).x;float pressure=(L+R+B+T-divergence)*0.25;gl_FragColor=vec4(pressure,0.0,0.0,1.0);}`;
  var gradSubFrag =`precision mediump float;precision mediump sampler2D;varying highp vec2 vUv;varying highp vec2 vL;varying highp vec2 vR;varying highp vec2 vT;varying highp vec2 vB;uniform sampler2D uPressure;uniform sampler2D uVelocity;void main(){float L=texture2D(uPressure,vL).x;float R=texture2D(uPressure,vR).x;float T=texture2D(uPressure,vT).x;float B=texture2D(uPressure,vB).x;vec2 velocity=texture2D(uVelocity,vUv).xy;velocity.xy-=vec2(R-L,T-B);gl_FragColor=vec4(velocity,0.0,1.0);}`;
  var displayFrag =`precision highp float;precision highp sampler2D;varying vec2 vUv;uniform sampler2D uTexture;void main(){vec3 C=texture2D(uTexture,vUv).rgb;float a=max(C.r,max(C.g,C.b));gl_FragColor=vec4(C,a);}`;

  // ── Compile helpers ─────────────────────────────────────────────────────────

  function compileShader(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.error(gl.getShaderInfoLog(s)); return null; }
    return s;
  }

  function createProgram(vertSrc, fragSrc) {
    var vert = compileShader(gl.VERTEX_SHADER, vertSrc);
    var frag = compileShader(gl.FRAGMENT_SHADER, fragSrc);
    var prog = gl.createProgram();
    gl.attachShader(prog, vert);
    gl.attachShader(prog, frag);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.error(gl.getProgramInfoLog(prog)); return null; }
    return {
      program: prog,
      uniforms: new Proxy({}, { get: function(_, name) { return gl.getUniformLocation(prog, name); } })
    };
  }

  var blitVert = `precision highp float;attribute vec2 aPosition;varying vec2 vUv;void main(){vUv=aPosition*0.5+0.5;gl_Position=vec4(aPosition,0.0,1.0);}`;
  var copyProg       = createProgram(blitVert, copyFrag);
  var clearProg      = createProgram(blitVert, clearFrag);
  var splatProg      = createProgram(blitVert, splatFrag);
  var advectionProg  = createProgram(baseVertSrc, advectionFrag);
  var divergenceProg = createProgram(baseVertSrc, divergenceFrag);
  var curlProg       = createProgram(baseVertSrc, curlFrag);
  var vorticityProg  = createProgram(baseVertSrc, vorticityFrag);
  var pressureProg   = createProgram(baseVertSrc, pressureFrag);
  var gradSubProg    = createProgram(baseVertSrc, gradSubFrag);
  var displayProg    = createProgram(blitVert, displayFrag);

  // ── Quad buffer ─────────────────────────────────────────────────────────────

  var quadVerts = new Float32Array([-1,-1, -1,1, 1,1, 1,-1]);
  var quadIdx   = new Uint16Array([0,1,2, 0,2,3]);
  var vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);
  var ibo = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, quadIdx, gl.STATIC_DRAW);

  function blit(target) {
    if (target == null) {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      gl.viewport(0, 0, target.width, target.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }

  // ── FBO helpers ─────────────────────────────────────────────────────────────

  function createFBO(w, h, internalFormat, format, type, param) {
    gl.activeTexture(gl.TEXTURE0);
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { texture: tex, fbo: fbo, width: w, height: h, attach: function(id){ gl.activeTexture(gl.TEXTURE0+id); gl.bindTexture(gl.TEXTURE_2D, tex); return id; } };
  }

  function createDoubleFBO(w, h, iF, f, type, param) {
    var fbo1 = createFBO(w,h,iF,f,type,param);
    var fbo2 = createFBO(w,h,iF,f,type,param);
    return {
      width:w, height:h,
      texelSizeX: 1/w, texelSizeY: 1/h,
      get read(){ return fbo1; },
      get write(){ return fbo2; },
      swap: function(){ var t=fbo1; fbo1=fbo2; fbo2=t; }
    };
  }

  var simW, simH, dyeW, dyeH;
  var velocity, dye, pressure, divergence, curl;

  function initFBOs() {
    var fT = ext.halfFloatTexType;
    var fRGBA = ext.formatRGBA;
    var fRG   = ext.formatRG;
    var fR    = ext.formatR;
    var filter = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;
    gl.disable(gl.BLEND);
    simW = config.SIM_RESOLUTION; simH = config.SIM_RESOLUTION;
    dyeW = config.DYE_RESOLUTION; dyeH = config.DYE_RESOLUTION;
    velocity  = createDoubleFBO(simW, simH, fRG.internalFormat,   fRG.format,   fT, filter);
    dye       = createDoubleFBO(dyeW, dyeH, fRGBA.internalFormat, fRGBA.format, fT, filter);
    pressure  = createDoubleFBO(simW, simH, fR.internalFormat,    fR.format,    fT, gl.NEAREST);
    divergence = createFBO(simW, simH, fR.internalFormat, fR.format, fT, gl.NEAREST);
    curl       = createFBO(simW, simH, fR.internalFormat, fR.format, fT, gl.NEAREST);
  }

  function resizeCanvas() {
    var w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      initFBOs();
    }
  }

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // ── Pointer setup ───────────────────────────────────────────────────────────

  function updatePointerDownData(p, id, posX, posY) {
    p.id = id;
    p.down = true;
    p.moved = false;
    p.texcoordX = posX / canvas.width;
    p.texcoordY = 1 - posY / canvas.height;
    p.prevTexcoordX = p.texcoordX;
    p.prevTexcoordY = p.texcoordY;
    p.deltaX = 0; p.deltaY = 0;
    p.color = generateColor();
  }

  function updatePointerMoveData(p, posX, posY) {
    p.prevTexcoordX = p.texcoordX;
    p.prevTexcoordY = p.texcoordY;
    p.texcoordX = posX / canvas.width;
    p.texcoordY = 1 - posY / canvas.height;
    p.deltaX = correctDeltaX(p.texcoordX - p.prevTexcoordX);
    p.deltaY = correctDeltaY(p.texcoordY - p.prevTexcoordY);
    p.moved = Math.abs(p.deltaX) > 0 || Math.abs(p.deltaY) > 0;
  }

  function correctDeltaX(d) { var ar = canvas.width / canvas.height; return ar < 1 ? d * ar : d; }
  function correctDeltaY(d) { var ar = canvas.width / canvas.height; return ar > 1 ? d / ar : d; }

  document.addEventListener('mousemove', function(e) {
    var p = pointers[0];
    if (!p.down) p.color = generateColor();
    updatePointerMoveData(p, e.clientX, e.clientY);
  });

  document.addEventListener('mousedown', function(e) {
    var p = pointers[0];
    p.down = true;
    p.color = generateColor();
    updatePointerMoveData(p, e.clientX, e.clientY);
  });

  document.addEventListener('mouseup', function() { pointers[0].down = false; });

  document.addEventListener('touchstart', function(e) {
    var touches = e.targetTouches;
    for (var i = 0; i < touches.length; i++) {
      if (i >= pointers.length) pointers.push(new pointerPrototype());
      updatePointerDownData(pointers[i+1]||pointers[0], touches[i].identifier, touches[i].clientX, touches[i].clientY);
    }
  }, { passive: true });

  document.addEventListener('touchmove', function(e) {
    var touches = e.targetTouches;
    for (var i = 0; i < touches.length; i++) {
      var p = pointers[i+1]||pointers[0];
      updatePointerMoveData(p, touches[i].clientX, touches[i].clientY);
    }
  }, { passive: true });

  document.addEventListener('touchend', function(e) {
    var touches = e.changedTouches;
    for (var i = 0; i < touches.length; i++) {
      var p = pointers[i+1]||pointers[0];
      if (p) p.down = false;
    }
  });

  // ── Color helpers ────────────────────────────────────────────────────────────

  function generateColor() {
    var c = HSVtoRGB(Math.random(), 1, 1);
    return [c.r * 0.15, c.g * 0.15, c.b * 0.15];
  }

  function HSVtoRGB(h, s, v) {
    var r,g,b,i=Math.floor(h*6),f=h*6-i,p=v*(1-s),q=v*(1-f*s),t=v*(1-(1-f)*s);
    switch(i%6){case 0:r=v;g=t;b=p;break;case 1:r=q;g=v;b=p;break;case 2:r=p;g=v;b=t;break;case 3:r=p;g=q;b=v;break;case 4:r=t;g=p;b=v;break;case 5:r=v;g=p;b=q;break;}
    return {r,g,b};
  }

  // ── Splat ────────────────────────────────────────────────────────────────────

  function splat(x, y, dx, dy, color) {
    var loc = splatProg.uniforms;
    gl.useProgram(splatProg.program);
    gl.uniform1i(loc.uTarget, velocity.read.attach(0));
    gl.uniform1f(loc.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(loc.point, x, y);
    gl.uniform3f(loc.color, dx, dy, 0);
    gl.uniform1f(loc.radius, correctRadius(config.SPLAT_RADIUS / 100));
    gl.bindAttribLocation(splatProg.program, 0, 'aPosition');
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    blit(velocity.write);
    velocity.swap();
    gl.uniform1i(loc.uTarget, dye.read.attach(0));
    gl.uniform3f(loc.color, color[0], color[1], color[2]);
    blit(dye.write);
    dye.swap();
  }

  function correctRadius(r) { var ar = canvas.width / canvas.height; return ar > 1 ? r * ar : r; }

  // ── Simulation step ──────────────────────────────────────────────────────────

  var lastTime = Date.now();

  function step(dt) {
    gl.disable(gl.BLEND);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);

    function setAttrib(prog) {
      var loc2 = gl.getAttribLocation(prog.program, 'aPosition');
      gl.enableVertexAttribArray(loc2);
      gl.vertexAttribPointer(loc2, 2, gl.FLOAT, false, 0, 0);
    }

    // curl
    gl.useProgram(curlProg.program); setAttrib(curlProg);
    gl.uniform2f(curlProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(curlProg.uniforms.uVelocity, velocity.read.attach(0));
    blit(curl);

    // vorticity
    gl.useProgram(vorticityProg.program); setAttrib(vorticityProg);
    gl.uniform2f(vorticityProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(vorticityProg.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(vorticityProg.uniforms.uCurl, curl.attach(1));
    gl.uniform1f(vorticityProg.uniforms.curl, config.CURL);
    gl.uniform1f(vorticityProg.uniforms.dt, dt);
    blit(velocity.write); velocity.swap();

    // divergence
    gl.useProgram(divergenceProg.program); setAttrib(divergenceProg);
    gl.uniform2f(divergenceProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(divergenceProg.uniforms.uVelocity, velocity.read.attach(0));
    blit(divergence);

    // clear pressure
    gl.useProgram(clearProg.program); setAttrib(clearProg);
    gl.uniform1i(clearProg.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(clearProg.uniforms.value, config.PRESSURE);
    blit(pressure.write); pressure.swap();

    // pressure iterations
    gl.useProgram(pressureProg.program); setAttrib(pressureProg);
    gl.uniform2f(pressureProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(pressureProg.uniforms.uDivergence, divergence.attach(0));
    for (var i = 0; i < config.PRESSURE_ITERATIONS; i++) {
      gl.uniform1i(pressureProg.uniforms.uPressure, pressure.read.attach(1));
      blit(pressure.write); pressure.swap();
    }

    // gradient subtract
    gl.useProgram(gradSubProg.program); setAttrib(gradSubProg);
    gl.uniform2f(gradSubProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(gradSubProg.uniforms.uPressure, pressure.read.attach(0));
    gl.uniform1i(gradSubProg.uniforms.uVelocity, velocity.read.attach(1));
    blit(velocity.write); velocity.swap();

    // advect velocity
    gl.useProgram(advectionProg.program); setAttrib(advectionProg);
    gl.uniform2f(advectionProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform2f(advectionProg.uniforms.dyeTexelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(advectionProg.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectionProg.uniforms.uSource,   velocity.read.attach(0));
    gl.uniform1f(advectionProg.uniforms.dt, dt);
    gl.uniform1f(advectionProg.uniforms.dissipation, config.VELOCITY_DISSIPATION);
    blit(velocity.write); velocity.swap();

    // advect dye
    gl.uniform2f(advectionProg.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
    gl.uniform1i(advectionProg.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectionProg.uniforms.uSource,   dye.read.attach(1));
    gl.uniform1f(advectionProg.uniforms.dissipation, config.DENSITY_DISSIPATION);
    blit(dye.write); dye.swap();
  }

  function render() {
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.useProgram(displayProg.program);
    var loc3 = gl.getAttribLocation(displayProg.program, 'aPosition');
    gl.enableVertexAttribArray(loc3);
    gl.vertexAttribPointer(loc3, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(displayProg.uniforms.uTexture, dye.read.attach(0));
    blit(null);
  }

  // ── Main loop ────────────────────────────────────────────────────────────────

  function loop() {
    if (!config.PAUSED) {
      var now = Date.now();
      var dt  = Math.min((now - lastTime) / 1000, 0.016667);
      lastTime = now;

      resizeCanvas();

      pointers.forEach(function(p) {
        if (p.moved) {
          p.moved = false;
          splat(p.texcoordX, p.texcoordY,
                p.deltaX * config.SPLAT_FORCE,
                p.deltaY * config.SPLAT_FORCE,
                p.color);
        }
      });

      step(dt);
      render();
    }
    requestAnimationFrame(loop);
  }

  // initial random splats
  for (var s = 0; s < 3; s++) {
    splat(Math.random(), Math.random(),
          (Math.random() - 0.5) * 10,
          (Math.random() - 0.5) * 10,
          generateColor());
  }

  loop();
})();
