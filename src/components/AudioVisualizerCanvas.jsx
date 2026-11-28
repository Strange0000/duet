import React, { useEffect, useRef } from 'react';

export default function AudioVisualizerCanvas({
  isPlaying = true,
  accentColor = '#7c3aed',
  secondaryColor = '#f43f5e',
  coverImage = null,
  className = '',
}) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let animId;
    let phase = 0;
    let lastDrawTime = 0;
    let width = 0;
    let height = 0;

    // Check prefers-reduced-motion
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let prefersReducedMotion = motionQuery.matches;
    const onMotionChange = (e) => { prefersReducedMotion = e.matches; };
    motionQuery.addEventListener('change', onMotionChange);

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resize();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(canvas);
    window.addEventListener('resize', resize);

    const draw = (timestamp) => {
      // Adaptive frame rate: skip frames when page hidden or reduced-motion
      if (document.hidden) {
        animId = requestAnimationFrame(draw);
        return; // Don't draw while hidden — save battery
      }

      // Throttle to ~30fps when prefers-reduced-motion or not playing
      const targetInterval = prefersReducedMotion || !isPlaying ? 33.3 : 16.6;
      if (timestamp - lastDrawTime < targetInterval) {
        animId = requestAnimationFrame(draw);
        return;
      }
      lastDrawTime = timestamp;

      const w = width;
      const h = height;

      ctx.clearRect(0, 0, w, h);

      // Subtle dark studio backdrop
      const bgGrad = ctx.createLinearGradient(0, 0, w, h);
      bgGrad.addColorStop(0, '#09090b');
      bgGrad.addColorStop(1, '#18181b');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, w, h);

      if (prefersReducedMotion) {
        // Static gradient only — no animation
        const orbGrad = ctx.createRadialGradient(w * 0.5, h * 0.45, 10, w * 0.5, h * 0.45, w * 0.48);
        orbGrad.addColorStop(0, `${accentColor}44`);
        orbGrad.addColorStop(0.55, `${secondaryColor}22`);
        orbGrad.addColorStop(1, 'transparent');
        ctx.fillStyle = orbGrad;
        ctx.fillRect(0, 0, w, h);
        animId = requestAnimationFrame(draw);
        return;
      }

      // Soft ambient glow orbs
      const orbX = w * 0.5 + Math.sin(phase * 0.6) * (w * 0.14);
      const orbY = h * 0.45 + Math.cos(phase * 0.45) * (h * 0.1);
      const orbGrad = ctx.createRadialGradient(orbX, orbY, 10, orbX, orbY, w * 0.48);
      orbGrad.addColorStop(0, `${accentColor}44`);
      orbGrad.addColorStop(0.55, `${secondaryColor}22`);
      orbGrad.addColorStop(1, 'transparent');
      ctx.fillStyle = orbGrad;
      ctx.fillRect(0, 0, w, h);

      // Flowing dual-wave ribbons
      const waves = [
        { amp: isPlaying ? 22 : 5, freq: 0.016, speed: 1, color: accentColor, alpha: 0.85, width: 2.5 },
        { amp: isPlaying ? 16 : 4, freq: 0.022, speed: -1.3, color: secondaryColor, alpha: 0.75, width: 2 },
        { amp: isPlaying ? 11 : 3, freq: 0.03, speed: 1.7, color: '#ffffff', alpha: 0.25, width: 1.2 },
      ];

      waves.forEach((wave) => {
        ctx.beginPath();
        ctx.strokeStyle = wave.color;
        ctx.globalAlpha = wave.alpha;
        ctx.lineWidth = wave.width;

        for (let x = 0; x <= w; x += 3) {
          const envelope = Math.sin((x / w) * Math.PI);
          const y =
            h * 0.5 +
            Math.sin(x * wave.freq + phase * wave.speed) * wave.amp * envelope +
            Math.cos(x * wave.freq * 0.5 - phase * 0.8) * (wave.amp * 0.45) * envelope;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      });

      ctx.globalAlpha = 1;

      // Subtle vertical spectrum bars along bottom
      const barCount = 36;
      const gap = w / barCount;
      for (let i = 0; i < barCount; i++) {
        const norm = i / barCount;
        const energy = isPlaying
          ? (Math.sin(phase * 2.2 + i * 0.55) * 0.5 + 0.5) *
            (Math.cos(phase * 1.3 - i * 0.3) * 0.4 + 0.6)
          : 0.12;
        const barH = 4 + energy * (h * 0.22);
        ctx.fillStyle = norm < 0.5 ? accentColor : secondaryColor;
        ctx.globalAlpha = 0.35;
        ctx.beginPath();
        const drawBar = ctx.roundRect || ctx.rect;
        drawBar.call(ctx, i * gap + gap * 0.25, h - barH - 8, Math.max(2, gap * 0.45), barH, 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      phase += isPlaying ? 0.035 : 0.008;
      animId = requestAnimationFrame(draw);
    };

    animId = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(animId);
      observer?.disconnect();
      window.removeEventListener('resize', resize);
      motionQuery.removeEventListener('change', onMotionChange);
    };
  }, [isPlaying, accentColor, secondaryColor]);

  return (
    <div className={`relative overflow-hidden rounded-2xl bg-zinc-950 ${className}`}>
      {coverImage && (
        <img
          src={coverImage}
          alt=""
          loading="lazy"
          className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-20 blur-xl scale-110"
        />
      )}
      <canvas ref={canvasRef} className="relative z-10 block h-full w-full" />
    </div>
  );
}
