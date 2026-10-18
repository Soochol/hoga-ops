import { useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { WORKSPACE_NAV_ITEMS } from '../nav/items';
import { useStaticDocumentTitle } from '../util/useDocumentTitle';
import './LandingPage.css';

const flow = [
  { id: 'observe', label: '01 관찰', caption: '차트와 호가로 움직임을 살피고, 더 자세히 보고 싶은 구간을 찾습니다.' },
  { id: 'save', label: '02 기록', caption: '차트의 관심 기간을 저장하고, 직접 만든 그룹에 종목과 시기를 함께 모읍니다.' },
  { id: 'review', label: '03 복기', caption: '저장한 기간을 다시 열어 현재 지표로 살피고, 메모를 더하며 비교합니다.' },
];
const candleHeights = [118, 109, 117, 95, 87, 100, 78, 67, 79, 63, 49, 62, 48, 31, 43, 24, 17, 31, 10, 18, 9, 21, 4, 12];
const barHeights = [20, 31, 24, 48, 38, 58, 46, 67, 52, 79, 65, 94, 80, 109];

function Arrow({ diagonal = true }: { diagonal?: boolean }) {
  return <svg className="arrow-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d={diagonal ? 'M5 19 19 5M5 5h14v14' : 'M4 12h16m-6-6 6 6-6 6'} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function BrandMark() {
  return <svg className="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M5 8h22v5H5zM13.5 15h5v12h-5z" fill="currentColor" /><path d="m5 22 5-5v10H5zM22 17l5-5v15h-5z" fill="currentColor" opacity=".5" /></svg>;
}

function Orbit() {
  return <div className="orbit" aria-hidden="true"><div className="orbit-glow" /><svg viewBox="0 0 640 640" fill="none">
    <defs><radialGradient id="tl-orb-fill"><stop stopColor="#5b7336" stopOpacity=".17" /><stop offset="1" stopColor="#bdff57" stopOpacity=".015" /></radialGradient><linearGradient id="tl-orb-line" x1="100" y1="100" x2="540" y2="540" gradientUnits="userSpaceOnUse"><stop stopColor="#dbff91" stopOpacity=".65" /><stop offset=".5" stopColor="#a2d64c" stopOpacity=".05" /><stop offset="1" stopColor="#d0ff73" stopOpacity=".5" /></linearGradient></defs>
    <circle cx="320" cy="320" r="234" fill="url(#tl-orb-fill)" stroke="url(#tl-orb-line)" />
    <g stroke="url(#tl-orb-line)"><ellipse cx="320" cy="320" rx="234" ry="72" transform="rotate(-30 320 320)" /><ellipse cx="320" cy="320" rx="234" ry="151" transform="rotate(-30 320 320)" /><ellipse cx="320" cy="320" rx="234" ry="207" transform="rotate(-30 320 320)" /><ellipse cx="320" cy="320" rx="72" ry="234" transform="rotate(-30 320 320)" /><ellipse cx="320" cy="320" rx="151" ry="234" transform="rotate(-30 320 320)" /></g>
    <ellipse cx="320" cy="320" rx="309" ry="104" transform="rotate(-30 320 320)" stroke="#c5ff67" strokeOpacity=".4" />
    <circle cx="320" cy="320" r="283" stroke="#a7d45e" strokeOpacity=".09" strokeDasharray="3 10" />
    <g fill="#c8ff70"><circle cx="73" cy="457" r="4" /><circle cx="531" cy="147" r="4" /><circle cx="403" cy="101" r="2.5" /><circle cx="139" cy="171" r="2" /></g>
    <path d="M320 22v16M312 30h16M602 320h16M610 312v16M21 320h16M29 312v16M320 602v16M312 610h16" stroke="#7b8c61" />
  </svg><span className="orb-coordinate coordinate-top">37°33′ N / 126°58′ E</span><span className="orb-coordinate coordinate-bottom">PERSPECTIVE IS EVERYTHING.</span></div>;
}

function CandleChart() {
  return <svg className="chart" viewBox="0 0 480 207" role="img" aria-label="가격 흐름과 관심 구간을 표현한 예시 캔들 차트">
    <defs><linearGradient id="tl-chart-area" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#c5f878" stopOpacity=".16" /><stop offset="1" stopColor="#c5f878" stopOpacity="0" /></linearGradient></defs>
    <g stroke="#d7efbd" strokeOpacity=".07"><path d="M0 34H480M0 76H480M0 118H480M0 160H480M40 0V180M136 0V180M232 0V180M328 0V180M424 0V180" /></g>
    <path d="m8 145 20-8 19 7 19-22 19-8 19 10 19-19 19-13 19 9 19-16 19-15 19 10 19-16 19-13 19 8 19-19 19-8 19 12 19-20 19 8 19-11 19 9 19-17 19 7V182H8Z" fill="url(#tl-chart-area)" />
    <rect x="272" y="12" width="129" height="164" rx="3" fill="#c7fa75" fillOpacity=".035" stroke="#b8eb6b" strokeOpacity=".5" strokeDasharray="3 5" />
    <text x="282" y="29" fill="#c8f78d" fontSize="10">관심 구간</text>
    {candleHeights.map((height, i) => <g key={i} className="candle" style={{ animationDelay: `${i * 24}ms` }}><line x1={12 + i * 19} y1={height + 20} x2={12 + i * 19} y2={height + 55} stroke={i % 4 === 2 ? '#6c8c6c' : '#c5fa79'} /><rect x={8 + i * 19} y={height + 29} width="8" height={i % 3 === 0 ? 18 : 12} rx=".7" fill={i % 4 === 2 ? '#6c8c6c' : '#c5fa79'} /><rect x={7 + i * 19} y={179 - (i % 5 + 1) * 4} width="10" height={(i % 5 + 1) * 4} fill="#8dba5d" fillOpacity=".16" /></g>)}
    <g fill="#6c7b68" fontSize="9"><text x="4" y="202">09:00</text><text x="141" y="202">10:00</text><text x="289" y="202">11:00</text><text x="436" y="202">12:00</text></g>
  </svg>;
}

export default function LandingPage() {
  const [tab, setTab] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  useStaticDocumentTitle('Ticklane');
  function handleTabKey(event: KeyboardEvent<HTMLButtonElement>) {
    const next = event.key === 'ArrowRight' ? (tab + 1) % 3 : event.key === 'ArrowLeft' ? (tab + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : null;
    if (next === null) return;
    event.preventDefault();
    setTab(next);
    event.currentTarget.parentElement?.querySelectorAll('button')[next]?.focus();
  }
  return <div className="project-landing" id="top">
    <header className="landing-header"><div className="nav">
      <a className="brand" href="#top" aria-label="Ticklane 홈"><BrandMark />Ticklane<span className="brand-dot">®</span></a>
      <button className="menu-toggle" aria-label={menuOpen ? '메뉴 닫기' : '메뉴 열기'} aria-expanded={menuOpen} aria-controls="landing-navigation" onClick={() => setMenuOpen(!menuOpen)}><span /><span /></button>
      <nav id="landing-navigation" className={menuOpen ? 'is-open' : ''} aria-label="주 메뉴">{WORKSPACE_NAV_ITEMS.map(item => <Link key={item.to} to={item.to}>{item.label}</Link>)}</nav>
      <Link className="nav-cta" to="/live">작업실 열기 <Arrow /></Link>
    </div></header>
    <main>
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy"><div className="eyebrow"><span className="status-dot" />THE PERSONAL MARKET OBSERVATORY</div>
          <h1 id="hero-title">움직임 너머의<br /><span>맥락을 읽다.</span><span className="title-period" aria-hidden="true">✳</span></h1>
          <p className="lead">수많은 신호 속, 당신만의 시선을 발견하세요.<br />관찰에서 기록, 그리고 복기까지.<br /><strong>시장을 이해하는 모든 순간을 하나로.</strong></p>
          <div className="actions"><Link className="primary" to="/live">라이브 시작하기 <Arrow /></Link><a className="secondary" href="#workflow">활용 흐름 살펴보기 <span aria-hidden="true">↓</span></a></div>
          <div className="hero-index"><div className="index-symbol" aria-hidden="true">↗</div><p>YOUR MARKET. YOUR PERSPECTIVE.<span>나만의 시장 분석 작업실, Ticklane</span></p></div>
        </div>
        <div className="visual"><Orbit /><div className="floating-label"><span className="status-dot" />A CLOSER LOOK.<span>A CLEARER VIEW.</span></div>
          <div className="preview"><div className="preview-head"><div className="preview-brand"><BrandMark /><strong>나의 시장 관찰실</strong></div><span className="tag">기능 설명용 예시</span><span className="window-dots" aria-hidden="true">•••</span></div>
            <div className="tabs" role="tablist" aria-label="활용 흐름">{flow.map((item, index) => <button key={item.id} id={`tab-${item.id}`} role="tab" aria-controls={item.id} aria-selected={tab === index} tabIndex={tab === index ? 0 : -1} onClick={() => setTab(index)} onKeyDown={handleTabKey}>{item.label}<span className="tab-indicator" /></button>)}</div>
            <div id="observe" className="scene" role="tabpanel" aria-labelledby="tab-observe" hidden={tab !== 0}><div className="scene-top"><div><span className="symbol-icon">S</span><strong>삼성전자</strong><span className="symbol-code">005930</span></div><span className="interval">5분봉 ↗</span></div><div className="chart-heading"><span>흐름을 포착하는 순간.</span><span className="chart-key"><i />PRICE ACTION</span></div><CandleChart /></div>
            <div id="save" className="scene" role="tabpanel" aria-labelledby="tab-save" hidden={tab !== 1}><div className="scene-top"><strong>종목뷰에 기간 저장</strong><span className="interval">나의 컬렉션</span></div><div className="row"><span>돌파 이후의 흐름<small>서로 다른 종목과 기간을 하나의 그룹으로</small></span><em>선택한 그룹 ↗</em></div><div className="row"><span>삼성전자<small>2026.08.18 — 2026.08.21 · 5분봉</small></span><em>기간 저장</em></div><div className="row"><span>SK하이닉스<small>2026.08.24 — 2026.08.26 · 5분봉</small></span><em>기간 저장</em></div></div>
            <div id="review" className="scene" role="tabpanel" aria-labelledby="tab-review" hidden={tab !== 2}><div className="scene-top"><strong>같은 종목, 서로 다른 구간</strong><span className="interval">다시 발견하기</span></div><div className="row"><span>삼성전자 · 첫 돌파<small>2026.08.18 — 2026.08.21</small></span><em>5분봉</em></div><div className="row"><span>삼성전자 · 눌림 이후<small>2026.08.25 — 2026.08.28</small></span><em>5분봉</em></div><div className="row"><span>메모와 함께 다시 보기<small>저장한 기간을 차트에서 열고 흐름을 비교합니다.</small></span><em>↗</em></div></div>
            <div className="preview-note" aria-live="polite"><span className="note-icon" aria-hidden="true">↳</span>{flow[tab].caption}</div>
          </div>
          <div className="floating-note"><span className="note-orbit" aria-hidden="true">◎</span><div>소음은 덜어내고.<br /><strong>인사이트는 더 선명하게.</strong></div><Arrow /></div>
          <div className="visual-label"><span>FIG. 01 — YOUR NEXT PERSPECTIVE</span><span>INTERACTIVE PREVIEW ↗</span></div>
        </div>
        <div className="hero-bottom"><span>DESIGNED FOR THE WAY YOU THINK.</span><a href="#workflow">SCROLL TO EXPLORE <span>↓</span></a><span>01 — 03</span></div>
      </section>
      <div className="signal-band" aria-hidden="true"><div className="signal-track">{[0, 1].map(i => <div className="signal-set" key={i}><span>OBSERVE</span><b>✳</b><span className="outlined">THE SIGNAL</span><b>↗</b><span>FIND YOUR EDGE</span><b>✳</b><span className="outlined">BEYOND THE NOISE</span><b>↗</b></div>)}</div></div>
      <section className="workflow" id="workflow" aria-labelledby="workflow-title">
        <div className="section-topline"><span className="section-label"><span className="status-dot" />BUILT FOR YOUR PROCESS</span><span className="section-count">[ THE WORKFLOW / 01—03 ]</span></div>
        <div className="intro"><h2 id="workflow-title">발견에서 복기까지,<br /><span>끊기지 않는 분석.</span></h2><p>흘러가는 숫자가, 쌓여가는 인사이트로.<br />시장을 넓게 살피고, 의미 있는 순간을 모으고,<br />다시 꺼내 보는 당신만의 분석 루틴을 만드세요.</p></div>
        <div className="steps">
          <article className="step observe-step"><div className="step-heading"><span className="number">01 / OBSERVE</span><span className="step-icon" aria-hidden="true">↗</span></div><div className="mini-visual bars" aria-hidden="true"><div className="bar-guide" /><div className="bars-inner">{barHeights.map((height, i) => <i key={i} style={{ height: `${height}px`, animationDelay: `${i * 45}ms` }} />)}</div><span className="mini-label">A WIDER PERSPECTIVE</span></div><h3>넓게 보고, <br />깊게 살피다.</h3><p>라이브 차트와 호가로 개별 종목을 정밀하게. <br />히트맵과 시장 종합으로 전체 흐름을 한눈에.</p><div className="links"><Link to="/live">라이브 <Arrow /></Link><Link to="/heatmap">히트맵 <Arrow /></Link><Link to="/market">시장 종합 <Arrow /></Link></div></article>
          <article className="step record-step"><div className="step-heading"><span className="number">02 / RECORD</span><span className="step-icon" aria-hidden="true">⊕</span></div><div className="mini-visual collection" aria-hidden="true"><div className="collection-card back-card">MY COLLECTION <span>↗</span></div><div className="collection-card front-card"><span className="folder-icon">▱</span><div>돌파 이후의 흐름<small>나만의 관심 구간 컬렉션</small></div><span className="collection-add">+</span></div><span className="mini-label">MOMENTS THAT MATTER</span></div><h3>의미 있는 <br />순간을 남기다.</h3><p>관심 있는 차트 구간과 데이터를 저장하고, <br />나만의 그룹으로 분석의 단서를 모으세요.</p><div className="links"><Link to="/capture">캡처 <Arrow /></Link><Link to="/inventory">보관함 <Arrow /></Link></div></article>
          <article className="step review-step"><div className="step-heading"><span className="number">03 / REVIEW</span><span className="step-icon" aria-hidden="true">↺</span></div><div className="mini-visual compare" aria-hidden="true"><svg viewBox="0 0 300 130" fill="none"><path d="M0 95h300M0 55h300" stroke="#c4daa6" strokeOpacity=".1" strokeDasharray="3 6" /><path d="m0 104 23-9 22 6 25-30 24 11 24-30 24 8 25-22 24 8 25-27 24 12 25-22 35 6" stroke="#c6fa7a" strokeWidth="2" /><path d="m0 115 23-7 22 9 25-24 24 12 24-31 24 13 25-16 24 10 25-22 24 13 25-28 35 9" stroke="#7f956a" strokeWidth="2" strokeDasharray="5 5" /></svg><span className="mini-label">CONNECT THE DOTS</span></div><h3>다시 보며, <br />차이를 찾다.</h3><p>같은 종목의 다른 시기, 다른 종목의 비슷한 흐름. <br />저장한 순간을 비교하며 나만의 관점을 쌓으세요.</p><div className="links"><Link to="/live">라이브에서 종목뷰 열기 <Arrow /></Link></div></article>
        </div>
      </section>
      <section className="toolkit" aria-labelledby="toolkit-title"><div><span className="section-label">ONE WORKSPACE. EVERY ANGLE.</span><h2 id="toolkit-title">시장을 보는 모든 도구.<br /><span>하나의 Ticklane.</span></h2></div><div className="tool-list">{WORKSPACE_NAV_ITEMS.map((item, i) => <Link key={item.to} to={item.to}><span className="tool-number">0{i + 1}</span>{item.label}<Arrow /></Link>)}</div></section>
      <section className="closing"><div className="closing-orbit" aria-hidden="true" /><span className="section-label">YOUR NEXT CHAPTER STARTS HERE</span><h2>다음 발견은,<br /><span>당신의 화면에서.</span></h2><p>관심 있는 종목 하나에서, 새로운 시선을 시작하세요.</p><Link className="primary" to="/live">분석 작업실로 이동 <Arrow /></Link><span className="closing-star" aria-hidden="true">✳</span></section>
    </main>
    <footer><div className="footer-top"><a className="brand" href="#top"><BrandMark />Ticklane<span className="brand-dot">®</span></a><p>관찰 · 기록 · 복기<br /><span>개인 시장 분석 작업실</span></p><a className="back-top" href="#top">BACK TO TOP ↑</a></div><div className="footer-bottom"><span>© {new Date().getFullYear()} TICKLANE</span><span>LESS NOISE. MORE PERSPECTIVE.</span><span>MADE FOR YOUR OWN EDGE. ↗</span></div></footer>
  </div>;
}
