// ═══════════════════════════════════════
//  FuturesBot v8 — GitHub Actions Runner
//  - Reads/writes state from GitHub Gist
//  - Exit strategy: fixed | trail | hybrid
//  - Min R:R configurable from bot HTML
//  - 4H filter on/off from bot HTML
//  - Max confirmation candles configurable
// ═══════════════════════════════════════

const GITHUB_TOKEN   = process.env.GITHUB_TOKEN
const GIST_ID        = process.env.GIST_ID
const GIST_URL       = `https://api.github.com/gists/${GIST_ID}`

// ── GitHub Gist ──────────────────────────
async function loadState() {
  try {
    const r = await fetch(GIST_URL, {
      headers: {
        "Authorization": `token ${GITHUB_TOKEN}`,
        "Accept": "application/vnd.github.v3+json"
      }
    })
    if (!r.ok) return null
    const d = await r.json()
    const content = d.files?.['state.json']?.content
    return content ? JSON.parse(content) : null
  } catch { return null }
}

async function saveState(state) {
  try {
    await fetch(GIST_URL, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `token ${GITHUB_TOKEN}`,
        "Accept": "application/vnd.github.v3+json"
      },
      body: JSON.stringify({ files: { 'state.json': { content: JSON.stringify(state) } } })
    })
  } catch(e) { console.error("saveState failed:", e.message) }
}

function defaultState() {
  return {
    portfolio: { balance: 100, equity: 100, risk: 0.02, defaultLev: 10, win: 0, loss: 0, realized: 0, usedMargin: 0 },
    positions: [],
    setups: [],
    history: [],
    growth: [],
    watchlist: ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT"],
    nextId: 1,
    pendingSignals: {},
    log: []
  }
}

// ── Fetch helper ─────────────────────────
async function fetchJSON(url, ms = 8000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0" }
    })
    clearTimeout(t)
    if (!r.ok) {
      console.error(`HTTP ${r.status} for ${url}`)
      return null
    }
    return await r.json()
  } catch(e) {
    clearTimeout(t)
    return null
  }
}

// ── OKX symbol mapping ───────────────────
// BTCUSDT → BTC-USDT-SWAP (perpetual futures)
function okxSym(sym) {
  const base = sym.replace('USDT', '')
  return `${base}-USDT-SWAP`
}

// ── OKX: Get OHLCV bars ──────────────────
// bar options: 1m, 3m, 5m, 15m, 30m, 1H, 2H, 4H, 1D
async function getOKXBars(sym, bar = '1H', limit = 100) {
  const instId = okxSym(sym)
  const d = await fetchJSON(
    `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`
  )
  if (!d?.data?.length) return null

  // OKX returns newest first — reverse to oldest first
  const bars = d.data.reverse().map(c => ({
    time:     Math.floor(parseInt(c[0]) / 1000),
    open:     parseFloat(c[1]),
    high:     parseFloat(c[2]),
    low:      parseFloat(c[3]),
    close:    parseFloat(c[4]),
    volume:   parseFloat(c[5]),
    takerBuy: parseFloat(c[5]) * 0.5  // default until taker data loads
  }))

  // Fix: correct params are ccy=BTC (not instId) + instType=CONTRACTS + period=1H
  const ccy = sym.replace('USDT', '')
  const tv = await fetchJSON(
    `https://www.okx.com/api/v5/rubik/stat/taker-volume?ccy=${ccy}&instType=CONTRACTS&period=1H`
  )
  if (tv?.data?.length) {
    // tv.data format: [timestamp, sellVol, buyVol] — newest first
    const tvMap = {}
    tv.data.forEach(r => {
      const ts = Math.floor(parseInt(r[0]) / 1000)
      tvMap[ts] = { sell: parseFloat(r[1]), buy: parseFloat(r[2]) }
    })
    bars.forEach(b => {
      const entry = tvMap[b.time]
      if (entry) {
        const total = entry.buy + entry.sell
        if (total > 0) b.takerBuy = b.volume * (entry.buy / total)
      }
    })
  }

  return bars
}

// ── OKX: Get current price ───────────────
async function getOKXPrice(sym) {
  const instId = okxSym(sym)
  const d = await fetchJSON(
    `https://www.okx.com/api/v5/market/ticker?instId=${instId}`
  )
  if (!d?.data?.[0]) return null
  // Validate: response instId must match what we requested
  const respInstId = d.data[0].instId
  if (respInstId && respInstId !== instId) {
    console.error(`Price mismatch: requested ${instId}, got ${respInstId}`)
    return null
  }
  const price = parseFloat(d.data[0].last)
  // Extra sanity: price must be positive and non-zero
  return price > 0 ? price : null
}

// ── OKX: Get Open Interest history ───────
// period options: 5m, 1H, 1D
async function getOKXOIHist(sym, period = '1H', limit = 10) {
  const instId = okxSym(sym)
  // Correct endpoint: /api/v5/rubik/stat/contracts/open-interest-volume
  // Required params: ccy (base currency), period
  const ccy = sym.replace('USDT', '')
  const d = await fetchJSON(
    `https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=${ccy}&period=1H`
  )
  if (!d?.data?.length) return null
  // Format: [timestamp, openInterest, volume] — newest first
  return d.data.slice(0, limit).reverse().map(r => ({
    time: Math.floor(parseInt(r[0]) / 1000),
    oi:   parseFloat(r[1])
  }))
}

// ── OKX: Get funding rate ────────────────
async function getOKXFundingRate(sym) {
  const d = await fetchJSON(
    `https://www.okx.com/api/v5/public/funding-rate?instId=${okxSym(sym)}`
  )
  return d?.data?.[0] ? parseFloat(d.data[0].fundingRate) : 0
}

// ── Indicators ───────────────────────────
function calcEMA(bars, n) {
  const k = 2/(n+1)
  let e = bars[0]?.close || 0
  return bars.map((b,i) => {
    if (i === 0) { e = b.close; return e }
    e = b.close * k + e * (1-k)
    return e
  })
}

function calcCVD(bars) {
  let cum = 0
  return bars.slice(-300).map(b => {
    const buy  = b.takerBuy || 0
    const sell = b.volume - buy
    cum += (buy - sell)
    return { time: b.time, value: cum }
  })
}

function calcVPVR(bars, bins = 24) {
  const highs = bars.map(b => b.high)
  const lows  = bars.map(b => b.low)
  const mn = Math.min(...lows), mx = Math.max(...highs)
  const bs = (mx - mn) / bins
  const vol = new Array(bins).fill(0)
  bars.forEach(b => {
    for (let i = 0; i < bins; i++) {
      const bl = mn + i * bs, bh = bl + bs
      const ov = Math.min(b.high, bh) - Math.max(b.low, bl)
      if (ov > 0) {
        const f = b.high !== b.low ? ov / (b.high - b.low) : 1
        vol[i] += b.volume * f
      }
    }
  })
  const pi  = vol.indexOf(Math.max(...vol))
  const poc = mn + (pi + .5) * bs
  const tot = vol.reduce((a, b) => a + b, 0)
  let va = vol[pi], u = pi, lo = pi
  while (va < tot * .7) {
    const cu = u + 1 < bins, cd = lo - 1 >= 0
    if (cu && cd) {
      if (vol[u+1] >= vol[lo-1]) { u++; va += vol[u] }
      else { lo--; va += vol[lo] }
    } else if (cu) { u++; va += vol[u] }
    else if (cd) { lo--; va += vol[lo] }
    else break
  }
  return { poc, vah: mn + (u + 1) * bs, val: mn + lo * bs }
}

function swingHigh(bars) {
  const lb = 5
  const currentPrice = bars[bars.length - 1].close
  for (let i = bars.length - lb - 2; i >= lb; i--) {
    const w = bars.slice(i - lb, i + lb + 1)
    if (bars[i].high === Math.max(...w.map(b => b.high)) && bars[i].high > currentPrice)
      return bars[i].high * 1.001
  }
  return Math.max(...bars.slice(-50).map(b => b.high)) * 1.001
}

function swingLow(bars) {
  const lb = 5
  const currentPrice = bars[bars.length - 1].close
  for (let i = bars.length - lb - 2; i >= lb; i--) {
    const w = bars.slice(i - lb, i + lb + 1)
    if (bars[i].low === Math.min(...w.map(b => b.low)) && bars[i].low < currentPrice)
      return bars[i].low * 0.999
  }
  return Math.min(...bars.slice(-50).map(b => b.low)) * 0.999
}

// ── Multi-timeframe level detection ──────
// 4H: major S/R, 1H: nearest swing, 5m: precise entry
async function getMultiTFLevels(sym, dir) {
  // Use last 24 candles 1H = 24 hours sweet spot for daily scalping
  const bars1h = await getOKXBars(sym, '1H', 24)
  if (!bars1h || bars1h.length < 12) return null

  const curPrice = bars1h[bars1h.length-1].close
  const high24h  = Math.max(...bars1h.map(b => b.high))
  const low24h   = Math.min(...bars1h.map(b => b.low))
  const swing1H  = dir === 'LONG' ? low24h : high24h

  // Reject if price too far from level (>5%)
  const distFromLevel = Math.abs(curPrice - swing1H) / curPrice
  if (distFromLevel > 0.05) return { rejected: `Price too far from 24h ${dir==='SHORT'?'high':'low'} (${(distFromLevel*100).toFixed(1)}%)` }

  // CVD check
  const cvd1h    = calcCVD(bars1h)
  const cvdSlice = cvd1h.slice(-8).map(c => c.value)
  const prSlice  = bars1h.slice(-8).map(b => b.close)
  const cvdUp    = cvdSlice[cvdSlice.length-1] > cvdSlice[0]
  const prUp     = prSlice[prSlice.length-1]   > prSlice[0]
  const cvdDiv   = dir === 'LONG' ? (!prUp && cvdUp) : (prUp && !cvdUp)
  const cvd1hOk  = cvdDiv
  const major4H  = swing1H

  // 5m entry precision
  const bars5m = await getOKXBars(sym, '5m', 80)
  let entryPrice = swing1H, sl5m = null, found5m = false

  if (bars5m && bars5m.length >= 20) {
    const cvd5m = calcCVD(bars5m)
    const tol   = swing1H * 0.008
    for (let i = bars5m.length - 2; i >= bars5m.length - 30; i--) {
      const b = bars5m[i], prev = bars5m[i-1]
      if (!prev) continue
      const nearLevel = dir === 'LONG' ? b.low <= swing1H + tol : b.high >= swing1H - tol
      if (!nearLevel) continue
      const bodySize  = Math.abs(b.close - b.open)
      const lowerWick = Math.min(b.open, b.close) - b.low
      const upperWick = b.high - Math.max(b.open, b.close)
      const isPinLong   = dir === 'LONG'  && lowerWick > bodySize * 1.5 && b.close > b.open
      const isPinShort  = dir === 'SHORT' && upperWick > bodySize * 1.5 && b.close < b.open
      const isEngulfL   = dir === 'LONG'  && b.close > prev.open && b.open < prev.close && b.close > b.open
      const isEngulfS   = dir === 'SHORT' && b.close < prev.open && b.open > prev.close && b.close < b.open
      const cvdAt   = cvd5m[i]?.value || 0
      const cvdPrev = cvd5m[i-3]?.value || cvdAt
      const cvd5mTurning = dir === 'LONG' ? cvdAt > cvdPrev : cvdAt < cvdPrev
      if (isPinLong || isPinShort || isEngulfL || isEngulfS || cvd5mTurning) {
        entryPrice = b.close
        sl5m = dir === 'LONG' ? b.low * 0.9985 : b.high * 1.0015
        found5m = true; break
      }
    }
  }

  if (!found5m) sl5m = dir === 'LONG' ? swing1H * 0.9985 : swing1H * 1.0015

  return { entryPrice, sl5m, major4H, swing1H, trend4h: 'n/a', cvd1hOk, found5m }
}

// ── Trend Follow Strategy ──────────────
// 1D EMA50 context + 4H CVD/OI exhaustion
async function detectTrendFollow(sym) {
  try {
  // STEP 1: VPVR from 1H
  const bars1h = await getOKXBars(sym, '1H', 48)
  if (!bars1h || bars1h.length < 20) return null

  const vpvr1h   = calcVPVR(bars1h)
  const curPrice = bars1h[bars1h.length-1].close
  const { vah, val, poc } = vpvr1h

  const atVAH    = Math.abs(curPrice - vah) / vah < 0.006
  const atVAL    = Math.abs(curPrice - val) / val < 0.006
  const aboveVAH = curPrice > vah * 1.015
  const belowVAL = curPrice < val * 0.985

  let dir = null
  if (atVAH || aboveVAH)      dir = 'SHORT'
  else if (atVAL || belowVAL) dir = 'LONG'
  else return null

  const zoneLabel = aboveVAH ? 'aboveVAH' : atVAH ? 'VAH' : belowVAL ? 'belowVAL' : 'VAL'

  // STEP 2: CVD 1H — cvdPrev = candle 8-15, cvdNow = 4 candle terakhir
  const bars1hCVD = await getOKXBars(sym, '1H', 20)
  if (!bars1hCVD || bars1hCVD.length < 15) return null

  const cvd1h      = calcCVD(bars1hCVD)
  const cvdNow     = cvd1h.slice(-4).map(c=>c.value).reduce((a,b)=>a+b,0)/4
  const cvdBefore  = cvd1h.slice(-15,-8).map(c=>c.value).reduce((a,b)=>a+b,0)/7
  const cvdRising  = cvdNow > cvdBefore
  const cvdFalling = cvdNow < cvdBefore

  const priceNow  = bars1hCVD.slice(-4).map(b=>b.close).reduce((a,b)=>a+b,0)/4
  const pricePrev = bars1hCVD.slice(-8,-4).map(b=>b.close).reduce((a,b)=>a+b,0)/4
  const priceUp   = priceNow > pricePrev
  const bullDiv   = !priceUp && cvdRising
  const bearDiv   = priceUp  && cvdFalling

  const cvdOk = dir === 'LONG' ? (cvdRising || bullDiv) : (cvdFalling || bearDiv)
  if (!cvdOk) return null

  // Fetch 15m for SL/volume
  const bars15m = await getOKXBars(sym, '15m', 20)

  // STEP 3: OI — aktif sebagai konfirmasi arah
  let oiRising = false, oiFalling = false, oiOk = true
  try {
    const bars1hOI = await getOKXBars(sym, '1H', 8)
    if (bars1hOI && bars1hOI.length >= 4) {
      const oiVals  = bars1hOI.map(b => b.openInterest||0).filter(v=>v>0)
      if (oiVals.length >= 4) {
        const oiNow  = oiVals.slice(-2).reduce((a,b)=>a+b,0)/2
        const oiPrev = oiVals.slice(-6,-2).reduce((a,b)=>a+b,0)/Math.max(oiVals.slice(-6,-2).length,1)
        oiRising  = oiNow > oiPrev * 1.02
        oiFalling = oiNow < oiPrev * 0.98
        if (oiNow < oiPrev * 0.85) oiOk = false
      }
    }
  } catch {}

  const cvdOiDivBear = cvdFalling && oiRising
  const cvdOiDivBull = cvdRising  && oiRising
  const cvdOiCovBear = cvdFalling && oiFalling
  const cvdOiCovBull = cvdRising  && oiFalling

  let divStatus = ''
  if (dir === 'SHORT') {
    if (cvdOiDivBear)      divStatus = 'CVD↓OI↑🔥Div'
    else if (cvdOiCovBear) divStatus = 'CVD↓OI↓Cover'
    else                   divStatus = 'CVD↓OI?'
  } else {
    if (cvdOiDivBull)      divStatus = 'CVD↑OI↑🔥Confirm'
    else if (cvdOiCovBull) divStatus = 'CVD↑OI↓Squeeze'
    else                   divStatus = 'CVD↑OI?'
  }

  // STEP 4: FR — loosened
  const frData = await getOKXFR(sym)
  const fr     = frData?.fr || 0
  if (dir === 'LONG'  && fr >  0.003) return null
  if (dir === 'SHORT' && fr < -0.003) return null

  const frNote = dir === 'LONG'
    ? fr < -0.001 ? 'SqzPotential' : ''
    : fr >  0.001 ? 'DumpPotential' : ''

  // STEP 5: SL
  const last12  = bars15m.slice(-12)
  const high12h = Math.max(...last12.map(b=>b.high))
  const low12h  = Math.min(...last12.map(b=>b.low))
  const sl = dir === 'SHORT'
    ? Math.max(vah, high12h) * 1.003
    : Math.min(val, low12h)  * 0.997

  const risk = Math.abs(curPrice - sl)
  if (risk <= 0 || risk / curPrice > 0.05) return null

  // TP: nearest VPVR level, respecting MIN_RR setting
  let tp
  if (dir === 'SHORT') {
    tp = aboveVAH ? vah * 0.998 : poc
    if (tp >= curPrice) tp = poc
    if (tp >= curPrice) tp = val
    if (Math.abs(tp - curPrice) / risk < MIN_RR) tp = curPrice - risk * MIN_RR
  } else {
    tp = belowVAL ? val * 1.002 : poc
    if (tp <= curPrice) tp = poc
    if (tp <= curPrice) tp = vah
    if (Math.abs(tp - curPrice) / risk < MIN_RR) tp = curPrice + risk * MIN_RR
  }

  const rr      = (Math.abs(tp - curPrice) / risk).toFixed(1)
  if (parseFloat(rr) < MIN_RR * 0.8) return null
  const divLabel = bearDiv ? 'BearDiv' : bullDiv ? 'BullDiv' : dir === 'SHORT' ? 'CVD↓' : 'CVD↑'

  // Confidence scoring with CVD/OI divergence
  let score = 0
  if (bearDiv || bullDiv) score += 20; else score += 10
  // CVD/OI divergence
  if (dir === 'SHORT') {
    if (cvdOiDivBear) score += 30
    else if (cvdOiCovBear) score += 15
    else score += 5
  } else {
    if (cvdOiDivBull) score += 25
    else if (cvdOiCovBull) score += 20
    else score += 5
  }
  const frSupportsLong  = dir === 'LONG'  && fr < -0.001
  const frSupportsShort = dir === 'SHORT' && fr >  0.001
  if (frSupportsLong || frSupportsShort) score += 20
  if (aboveVAH || belowVAL) score += 15; else score += 8
  const rrNum2 = parseFloat(rr)
  if (rrNum2 >= 2.5) score += 10; else if (rrNum2 >= 1.5) score += 5
  const volNow2  = bars15m ? bars15m.slice(-4).map(b=>b.volume||0).reduce((a,b)=>a+b,0)/4 : 0
  const volPrev2 = bars15m ? bars15m.slice(-8,-4).map(b=>b.volume||0).reduce((a,b)=>a+b,0)/4 : 1
  if (volNow2 < volPrev2 * 0.8) score += 5

  if (score < 75) return null  // only Good(75+) and Strong(85+)

  const confLabel = score >= 85 ? 'Strong' : score >= 75 ? 'Good' : 'Weak'

  return {
    dir, price: curPrice, sl, tp, rr,
    vpvrZone: zoneLabel, fr, score, confLabel, divStatus,
    reason: `TF ${dir} @ ${zoneLabel} | ${divStatus} | FR:${(fr*100).toFixed(3)}% | ${confLabel}(${score}) | R:R 1:${rr}`
  }
  } catch(e) { return null }
}

// ── Telegram Notification ───────────────
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN   || state.telegramSettings?.token   || ''
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || state.telegramSettings?.chatId  || ''

async function sendTelegram(msg) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML' })
    })
  } catch {}
}

function fmtTgEntry(sym, sig) {
  const emoji = sig.dir === 'LONG' ? '📈' : '📉'
  const zone  = sig.vpvrZone || ''
  const fr    = sig.fr ? `FR: ${(parseFloat(sig.fr)*100).toFixed(3)}%` : ''
  return `🤖 <b>FuturesBot Signal</b>

${emoji} <b>${sig.dir} — ${sym}</b>
──────────────────
Entry:  <code>${parseFloat(sig.price).toFixed(4)}</code>
SL:     <code>${parseFloat(sig.sl).toFixed(4)}</code>
TP:     <code>${parseFloat(sig.tp).toFixed(4)}</code>
R:R:    <b>1:${sig.rr}</b>
──────────────────
Zone:   ${zone}  ${fr}
${sig.reason || ''}
──────────────────
${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB`
}

function fmtTgClose(t, closePrice, reason, pnl) {
  const emoji  = pnl >= 0 ? '✅' : '❌'
  const pnlStr = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2)
  const roi    = t.margin > 0 ? ((pnl / t.margin) * 100).toFixed(1) : '0'
  return `${emoji} <b>CLOSED — ${t.sym} ${t.side}</b>

Exit:     <code>${parseFloat(closePrice).toFixed(4)}</code>
Reason:   <b>${reason}</b>
PnL:      <b>${pnlStr}</b> (+${roi}% ROI)
──────────────────
${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB`
}

// ── Phase 1: Detect CVD + OI divergence ──
async function detectPhase1(sym, bars) {
  const n = 14
  const cvd = calcCVD(bars)
  if (cvd.length < n) return null

  const cvdSlice = cvd.slice(-n).map(c => c.value)
  const prSlice  = bars.slice(-n).map(b => b.close)
  const cvdUp    = cvdSlice[cvdSlice.length-1] > cvdSlice[0]
  const prUp     = prSlice[prSlice.length-1]   > prSlice[0]
  const cvdType  = prUp && !cvdUp ? 'bearish' : !prUp && cvdUp ? 'bullish' : 'neutral'
  if (cvdType === 'neutral') return null

  const vpvr     = calcVPVR(bars)
  const price    = bars[bars.length-1].close
  const vpvrZone = price > vpvr.vah ? 'above_va' : price < vpvr.val ? 'below_va' : 'in_va'

  // OI trend — use % change for meaningful signal
  let oiTrend = 'neutral'
  const oiHist = await getOKXOIHist(sym, '1H', 10)
  if (oiHist && oiHist.length >= 3) {
    const first = oiHist[0].oi
    const last  = oiHist[oiHist.length-1].oi
    const oiPctChange = first > 0 ? ((last - first) / first) * 100 : 0
    // OI rising = up more than 0.2% over the period
    // OI falling = down more than 0.2%
    oiTrend = oiPctChange > 0.2 ? 'rising' : oiPctChange < -0.2 ? 'falling' : 'neutral'
  }

  // Funding rate
  const fr = await getOKXFundingRate(sym)

  // Phase 1: CVD divergence + OI rising
  let dir = null
  if (cvdType === 'bearish' && oiTrend === 'rising') dir = 'SHORT'
  if (cvdType === 'bullish' && oiTrend === 'rising') dir = 'LONG'
  if (!dir) return null

  // FR filter
  if (dir === 'LONG'  && fr >  0.001) return null
  if (dir === 'SHORT' && fr < -0.001) return null

  // VPVR Zone Filter — reject entries at wrong price location
  if (dir === 'SHORT' && vpvrZone === 'below_va') return null
  if (dir === 'LONG'  && vpvrZone === 'above_va') return null

  if (ENTRY_MODE === 'limit') {
    const mtf = await getMultiTFLevels(sym, dir)
    if (!mtf || mtf.rejected) return null  // 4H trend opposes direction

    const limitEntry = mtf.entryPrice
    const limitSL    = mtf.sl5m || (dir === 'LONG' ? mtf.swing1H * 0.9985 : mtf.swing1H * 1.0015)
    const limitRisk  = Math.abs(limitEntry - limitSL)
    if (limitRisk <= 0) return null

    const bars4hTp = await getOKXBars(sym, '4H', 80)
    let limitTP = dir === 'LONG' ? limitEntry + limitRisk * 3 : limitEntry - limitRisk * 3
    if (bars4hTp) {
      const tp4H   = dir === 'LONG' ? swingHigh(bars4hTp) : swingLow(bars4hTp)
      const tp4HRR = Math.abs(tp4H - limitEntry) / limitRisk
      if (tp4HRR >= 2) limitTP = tp4H
    }
    const limitRR = (Math.abs(limitTP - limitEntry) / limitRisk).toFixed(1)
    if (parseFloat(limitRR) < 1.9) return null

    return { dir, price: limitEntry, sl: limitSL, tp: limitTP,
      rr: limitRR, cvdType, oiTrend, vpvrZone, fr,
      isLimit: true, marketPrice: price,
      major4H: mtf.major4H, swing1H: mtf.swing1H,
      cvd1hOk: mtf.cvd1hOk, found5m: mtf.found5m }
  }

  const sl = dir === 'SHORT' ? swingHigh(bars) : swingLow(bars)
  if (dir === 'SHORT' && sl <= price) return null
  if (dir === 'LONG'  && sl >= price) return null
  const risk = Math.abs(price - sl)
  const tp   = dir === 'SHORT' ? price - risk * 2 : price + risk * 2
  const rr   = risk > 0 ? (Math.abs(tp - price) / risk).toFixed(2) : 0
  if (parseFloat(rr) < 1.9) return null

  return { dir, price, sl, tp, rr, cvdType, oiTrend, vpvrZone, fr }
}

// ── Phase 2: 30m confirmation check ──────
async function checkConfirmation(sym, pending) {
  const bars30 = await getOKXBars(sym, '30m', 10)
  if (!bars30 || bars30.length < 6) return { confirmed: false, reason: '30m fetch failed' }

  const cvd30     = calcCVD(bars30)
  const mid       = Math.floor(cvd30.length / 2)
  const earlyCVD  = cvd30[mid-1].value - cvd30[0].value
  const recentCVD = cvd30[cvd30.length-1].value - cvd30[mid].value

  // OI slope — use % change instead of absolute value
  // Absolute value is always huge (millions) and trending up → meaningless
  // % change gives a normalized signal: negative = OI contracting
  let oiSlopePct = 0
  const oi = await getOKXOIHist(sym, '1H', 8)
  if (oi && oi.length >= 4) {
    const oiMid   = Math.floor(oi.length / 2)
    const earlyOI = oi.slice(0, oiMid).reduce((s, x) => s + x.oi, 0) / oiMid
    const recOI   = oi.slice(oiMid).reduce((s, x) => s + x.oi, 0) / (oi.length - oiMid)
    oiSlopePct    = earlyOI > 0 ? ((recOI - earlyOI) / earlyOI) * 100 : 0
  }

  // OI confirming = contracting by at least 0.1%
  const oiContracting = oiSlopePct < -0.1

  const debug = `CVD30(early:${earlyCVD.toFixed(0)} recent:${recentCVD.toFixed(0)}) OI%:${oiSlopePct.toFixed(3)}%`

  if (pending.dir === 'LONG') {
    const cvdConfirm = earlyCVD < 0 && recentCVD > 0  // CVD turning bullish
    const oiConfirm  = oiContracting                    // OI contracting (shorts closing)
    return {
      confirmed: cvdConfirm || oiConfirm,
      reason: `${debug} | CVD:${cvdConfirm} OI:${oiConfirm}`,
      cvdConfirm, oiConfirm
    }
  }
  if (pending.dir === 'SHORT') {
    const cvdConfirm = recentCVD <= 0   // CVD still bearish
    const oiConfirm  = oiContracting    // OI contracting (longs closing)
    return {
      confirmed: cvdConfirm || oiConfirm,
      reason: `${debug} | CVD:${cvdConfirm} OI:${oiConfirm}`,
      cvdConfirm, oiConfirm
    }
  }
  return { confirmed: false, reason: 'unknown direction' }
}

// ── Fix 3: 4H trend filter ────────────────
async function check4HTrend(sym, dir) {
  const bars4h = await getOKXBars(sym, '4H', 20)
  if (!bars4h || bars4h.length < 10) return { ok: true, reason: '4H fetch failed — allowed through' }

  const recent = bars4h.slice(-5).map(b => b.close)
  const prev   = bars4h.slice(-10, -5).map(b => b.close)
  const recentAvg = recent.reduce((s, v) => s + v, 0) / recent.length
  const prevAvg   = prev.reduce((s, v) => s + v, 0)   / prev.length

  // Use percentage difference — not just direction
  // Sideways market (< 0.5% difference) → allow both directions
  const pctDiff = (recentAvg - prevAvg) / prevAvg * 100
  const trend4h = pctDiff > 0.5 ? 'up' : pctDiff < -0.5 ? 'down' : 'sideways'
  const debug   = `4H trend:${trend4h} (${pctDiff.toFixed(2)}%)`

  // Sideways → allow any direction (market has no strong bias)
  if (trend4h === 'sideways') return { ok: true, reason: `${debug} — sideways, both allowed` }

  // Trending — only enter with the trend
  if (dir === 'SHORT' && trend4h === 'down') return { ok: true,  reason: `${debug} — SHORT aligned` }
  if (dir === 'LONG'  && trend4h === 'up')   return { ok: true,  reason: `${debug} — LONG aligned` }

  return { ok: false, reason: `${debug} — ${dir} against 4H trend` }
}

// ── Paper trading engine ──────────────────
function symAlreadyActive(state, sym) {
  return state.positions.some(t => t.sym === sym)
}

function openPosition(state, side, ep, sl, tp, leverage, sym) {
  if (state.positions.length >= 3) return 'max'
  if (symAlreadyActive(state, sym)) return 'duplicate'
  const p      = state.portfolio
  const risk   = p.balance * p.risk
  const rawSlDist = Math.abs(ep - sl)
  const minSlDist = ep * 0.008
  const slDist = Math.max(rawSlDist, minSlDist)
  if (slDist <= 0) return 'invalid'
  const qty    = risk / slDist
  const posVal = qty * ep
  const margin = posVal / leverage
  if (margin > p.balance) return 'insufficient'
  state.positions.push({
    id: state.nextId++, sym, side, lev: leverage,
    ep, sl, tp, price: ep, tsl: sl, trailOn: false,
    posVal, margin, risk, qty,
    high: ep, low: ep, upnl: 0,
    time: Date.now()
  })
  p.usedMargin = (p.usedMargin || 0) + margin
  state.setups = state.setups.filter(s => s.sym !== sym)
  // Telegram notification
  const rr = Math.abs(tp-ep) / Math.abs(ep-sl)
  sendTelegram(fmtTgEntry(sym, { dir: side, price: ep, sl, tp, rr: rr.toFixed(1), vpvrZone: '', fr: '', reason: '' }))
  return 'ok'
}

function closePosition(state, t, closePrice, reason) {
  const pnl = t.side === 'LONG'
    ? (closePrice - t.ep) / t.ep * t.posVal
    : (t.ep - closePrice) / t.ep * t.posVal
  const roi = t.margin > 0 ? (pnl / t.margin) * 100 : 0
  state.portfolio.realized = (state.portfolio.realized || 0) + pnl
  state.portfolio.balance  += pnl
  state.portfolio.usedMargin = Math.max(0, (state.portfolio.usedMargin || 0) - t.margin)
  // Only count W/L at final close — not at partial close
  if (!t.halfClosed) {
    if (pnl > 0) state.portfolio.win++; else state.portfolio.loss++
  } else {
    const totalPnl = pnl + (t._partialPnl || 0)
    if (totalPnl > 0) state.portfolio.win++; else state.portfolio.loss++
  }
  state.history.unshift({
    ...t,
    closePrice, pnl, roi,
    closeReason:  reason,
    closeTime:    Date.now(),
    exitNote:     t._exitNote || null  // scan-price note for transparency
  })
  if (state.history.length > 200) state.history.length = 200
  state.growth.push({ t: Date.now(), equity: state.portfolio.balance })
  if (state.growth.length > 500) state.growth.shift()
  // Telegram notification
  sendTelegram(fmtTgClose(t, closePrice, reason, pnl))
}

function updatePositions(state, prices, exitStrategy = 'trail', trailCallback = 0.025) {
  const toClose   = []
  const toPartial = []

  for (const t of state.positions) {
    const price = prices[t.sym]
    if (!price) continue

    // Sanity check: price must be within 20% of entry price
    // Prevents wrong-coin price contamination or stale data
    const priceDeviation = Math.abs(price - t.ep) / t.ep
    if (priceDeviation > 0.20) {
      scanLog.push(`${t.sym}: ⚠ Skipping price update — suspicious price ${price} vs entry ${t.ep} (${(priceDeviation*100).toFixed(1)}% deviation)`)
      continue
    }

    t.price = price
    t.high  = Math.max(t.high, price)
    t.low   = Math.min(t.low, price)
    t.upnl  = t.side === 'LONG'
      ? (price - t.ep) / t.ep * t.posVal
      : (t.ep - price) / t.ep * t.posVal
    // Fix margin if missing
    if (!t.margin || t.margin <= 0) t.margin = t.posVal / (t.lev || 50)
    const profR  = t.risk > 0 ? t.upnl / t.risk : 0
    const slDist = Math.abs(t.ep - t.sl)

    if (exitStrategy === 'fixed') {
      t.trailOn = false
      t.tsl     = t.sl

    } else if (exitStrategy === 'trail') {
      if (profR >= 1 && !t.trailOn)   { t.tsl = t.ep; t.trailOn = true }
      if (profR >= 1.5 && t.trailOn) {
        if (t.side === 'LONG') { const n = price - slDist; if (n > t.tsl) t.tsl = n }
        else                   { const n = price + slDist; if (n < t.tsl) t.tsl = n }
      }

    } else if (exitStrategy === 'hybrid') {
      const currentRoi = t.margin > 0 ? (t.upnl || 0) / t.margin : 0
      if (!t.halfClosed) {
        if (currentRoi >= PARTIAL_ROI) {
          toPartial.push({ t, price })
          continue
        }
        // SL stays original until partial TP
      } else {
        if (t.side === 'LONG') {
          const newTsl = t.high * (1 - trailCallback)
          if (!t.trailOn || newTsl > t.tsl) { t.tsl = newTsl; t.trailOn = true }
        } else {
          const newTsl = t.low * (1 + trailCallback)
          if (!t.trailOn || newTsl < t.tsl) { t.tsl = newTsl; t.trailOn = true }
        }
      }
    }

    const hitSL = t.side === 'LONG' ? price <= t.tsl : price >= t.tsl
    const hitTP = exitStrategy !== 'trail'
      ? (t.side === 'LONG' ? price >= t.tp : price <= t.tp)
      : false

    const fullClose = (hitTP && exitStrategy !== 'hybrid') || hitSL
    if (fullClose) {
      let reason
      if (exitStrategy === 'hybrid' && t.halfClosed && hitSL && t.trailOn) {
        reason = 'Trailing Stop'
      } else if (hitTP) {
        reason = 'TP'
      } else if (t.trailOn) {
        reason = 'Trailing Stop'
      } else {
        reason = 'SL'
      }
      toClose.push({ t, price, tpSl: hitTP ? t.tp : t.tsl, reason })
    }
  }

  // Process partial closes (hybrid 50%)
  for (const { t, price } of toPartial) {
    const halfPosVal = t.posVal * 0.5
    const halfMargin = t.margin * 0.5
    const pnl = t.side === 'LONG'
      ? (price - t.ep) / t.ep * halfPosVal
      : (t.ep - price) / t.ep * halfPosVal
    const roi = halfMargin > 0 ? (pnl / halfMargin) * 100 : 0
    state.portfolio.realized = (state.portfolio.realized || 0) + pnl
    state.portfolio.balance  += pnl
    state.portfolio.usedMargin = Math.max(0, (state.portfolio.usedMargin || 0) - halfMargin)
    // Do NOT count W/L here — counted at final close using total PnL
    state.history.unshift({ ...t, closePrice: price, pnl, roi,
      closeReason: 'Partial TP (50%)', closeTime: Date.now(), partial: true })
    if (state.history.length > 200) state.history.length = 200
    state.growth.push({ t: Date.now(), equity: state.portfolio.balance })
    if (state.growth.length > 500) state.growth.shift()
    // Update remaining 50%
    const slDist = Math.abs(t.ep - t.sl)
    t.posVal = halfPosVal; t.margin = halfMargin
    t.qty    = (t.qty || 0) * 0.5; t.risk = t.risk * 0.5
    t._partialPnl = pnl  // store for final W/L calculation
    t.halfClosed = true; t.trailOn = true
    // tsl starts at partial TP price with callback offset — gives room to trail
    t.tsl = t.side === 'LONG'
      ? price * (1 - trailCallback)
      : price * (1 + trailCallback)
    // Reset high/low so callback trailing starts fresh from partial TP price
    t.high = price; t.low = price
    t.tp = t.side === 'LONG' ? t.ep + slDist * 4 : t.ep - slDist * 4
    scanLog.push(`${t.sym}: 💰 Partial TP 50% @ ${price.toFixed(4)} | PnL: +$${pnl.toFixed(2)} | Trail stop: ${t.tsl.toFixed(4)}`)
  }

  // Process full closes
  for (const { t, price, tpSl, reason } of toClose) {
    t._exitNote = `Scan price: ${price.toFixed(4)} | ${reason} level: ${tpSl.toFixed(4)}`
    closePosition(state, t, price, reason)
    state.positions = state.positions.filter(p => p.id !== t.id)
    if (state.positions.length < 3 && state.setups.length > 0) {
      const next = state.setups.find(s => !state.positions.some(p => p.sym === s.sym))
      if (next) {
        const res = openPosition(state, next.side, next.ep, next.sl, next.tp, next.lev || 10, next.sym)
        if (res === 'ok') {
          state.setups = state.setups.filter(s => s.id !== next.id)
          scanLog.push(`${next.sym}: 🔄 Auto-executed from setup backlog (slot freed by ${t.sym} ${reason})`)
        }
      }
    }
  }
}

// ── Main cron ─────────────────────────────
async function main() {
  const runStart = new Date().toISOString()
  console.log(`[${runStart}] FuturesBot v3 cron started`)

  if (!JSONBIN_KEY || !JSONBIN_BIN_ID) {
    console.error("WARNING: JSONBIN_KEY or JSONBIN_BIN_ID not set. Add them to Environment Variables.")
    return
  }

  // Load state
  let state = await loadState()
  if (!state || !state.portfolio) {
    console.log("No existing state found, using defaults")
    state = defaultState()
  }
  if (!state.log)            state.log = []
  if (!state.nextId)         state.nextId = 1
  if (!state.pendingSignals) state.pendingSignals = {}

  // Read strategy settings saved by bot HTML
  const strat           = state.strategySettings || {}
  const EXIT_STRATEGY    = strat.exitStrategy || 'trail'
  const MIN_RR           = parseFloat(strat.minRR || 2)
  const USE_4H_FILTER    = strat.use4HFilter !== false
  const MAX_CANDLE_WAIT  = parseInt(strat.maxCandles || 4)
  const TRAIL_CALLBACK   = parseFloat(strat.trailCallback || 2.5) / 100
  const ENTRY_MODE       = strat.entryMode || 'confirmation'
  const PARTIAL_ROI      = parseFloat(strat.partialRoi || 100) / 100

  console.log(`[Strategy] exit:${EXIT_STRATEGY} minRR:${MIN_RR} 4H:${USE_4H_FILTER} maxCandles:${MAX_CANDLE_WAIT} callback:${(TRAIL_CALLBACK*100).toFixed(1)}% entry:${ENTRY_MODE}`)

  const watchlist = state.watchlist || ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT"]
  const prices    = {}
  const scanLog   = []

  // ── Step 1: Fetch current prices ─────────
  for (const sym of watchlist) {
    const p = await getOKXPrice(sym)
    if (p) prices[sym] = p
    await new Promise(r => setTimeout(r, 400)) // increased from 200ms to reduce race conditions
  }

  // ── Step 2: Update open positions ────────
  updatePositions(state, prices, EXIT_STRATEGY, TRAIL_CALLBACK)

  // Log any closed positions
  const closedThisRun = state.history.filter(h =>
    h.closeTime && Date.now() - h.closeTime < 70 * 60 * 1000
  )
  for (const h of closedThisRun) {
    const pnlStr = h.pnl >= 0 ? `+$${h.pnl.toFixed(2)}` : `-$${Math.abs(h.pnl).toFixed(2)}`
    scanLog.push(`${h.sym}: 🔒 Position closed (${h.closeReason}) | PnL: ${pnlStr} | ROI: ${h.roi.toFixed(1)}%`)
  }

  // ── Step 3: Check pending signals ────────
  for (const sym of Object.keys(state.pendingSignals)) {
    const pending = state.pendingSignals[sym]

    // Skip if already executed by HTML bot — anti-double-entry
    if (pending.executedBy) {
      scanLog.push(`${sym}: ⏭ Signal already executed by ${pending.executedBy} — skipping`)
      delete state.pendingSignals[sym]
      continue
    }

    // Skip if already has position
    if (symAlreadyActive(state, sym)) {
      delete state.pendingSignals[sym]
      continue
    }

    // Handle pending LIMIT orders
    if (pending.isLimit) {
      const price = prices[sym]
      if (!price) continue
      const ageHours = (Date.now() - (pending.detectedAt || 0)) / 3600000

      // Invalidation 1: timeout
      if (ageHours > 4) {
        scanLog.push(`${sym}: ⏰ Limit ${pending.dir} expired (4h) @ ${pending.price.toFixed(4)}`)
        delete state.pendingSignals[sym]; continue
      }

      // Invalidation 2: price drifted >5% from limit level
      const drift = Math.abs(price - pending.price) / pending.price
      if (drift > 0.05) {
        scanLog.push(`${sym}: ❌ Limit ${pending.dir} invalidated — price moved ${(drift*100).toFixed(1)}% from entry level`)
        delete state.pendingSignals[sym]; continue
      }

      // Invalidation 3: CVD reversed
      const bars = await getOKXBars(sym, '1H', 20)
      if (bars && bars.length >= 14) {
        const cvd = calcCVD(bars)
        const n = 14
        const cvdSlice = cvd.slice(-n).map(c => c.value)
        const prSlice  = bars.slice(-n).map(b => b.close)
        const cvdUp = cvdSlice[cvdSlice.length-1] > cvdSlice[0]
        const prUp  = prSlice[prSlice.length-1] > prSlice[0]
        const nowCvd = prUp && !cvdUp ? 'bearish' : !prUp && cvdUp ? 'bullish' : 'neutral'
        if (nowCvd !== pending.cvdType && nowCvd !== 'neutral') {
          scanLog.push(`${sym}: ❌ Limit ${pending.dir} invalidated — CVD reversed to ${nowCvd}`)
          delete state.pendingSignals[sym]; continue
        }
      }

      // Check if triggered
      const triggered = pending.dir === 'LONG'
        ? price <= pending.price
        : price >= pending.price
      if (triggered && state.positions.length < 3) {
        const res = openPosition(state, pending.dir, pending.price, pending.sl, pending.tp, state.portfolio.defaultLev || 10, sym)
        if (res === 'ok') {
          scanLog.push(`${sym}: 🎯 Limit ${pending.dir} TRIGGERED @ ${pending.price.toFixed(4)} | R:R 1:${pending.rr}`)
          delete state.pendingSignals[sym]
        }
      } else {
        scanLog.push(`${sym}: ⏳ Limit ${pending.dir} waiting @ ${pending.price.toFixed(4)} (current: ${price.toFixed(4)})`)
      }
      continue
    }

    pending.candleCount = (pending.candleCount || 1) + 1
    const currentPrice  = prices[sym] || pending.price

    // Fix 2: Raised threshold 3% → 5%
    // Before: signal cancelled if price moved 3% (too easy to trigger in crypto)
    // Now: signal gets more room — cancelled only if price moved 5%
    // Analogy: giving the trade more breathing room before giving up
    const priceMove = Math.abs(currentPrice - pending.price) / pending.price
    if (priceMove > 0.05) {
      scanLog.push(`${sym}: ❌ Signal cancelled — price moved ${(priceMove*100).toFixed(1)}% from entry (>5%)`)
      delete state.pendingSignals[sym]
      await new Promise(r => setTimeout(r, 300))
      continue
    }

    // Expire after max candles
    if (pending.candleCount > MAX_CANDLE_WAIT) {
      scanLog.push(`${sym}: ❌ Signal expired — no confirmation after ${MAX_CANDLE_WAIT} candles`)
      delete state.pendingSignals[sym]
      continue
    }

    // Check confirmation
    const conf = await checkConfirmation(sym, pending)
    if (conf.confirmed) {
      // Check 4H trend alignment — respects USE_4H_FILTER setting
      const trend = await check4HTrend(sym, pending.dir)
      if (USE_4H_FILTER && !trend.ok) {
        scanLog.push(`${sym}: ⚠ Confirmed but blocked by 4H — ${trend.reason}`)
        pending.candleCount-- // don't waste a candle slot on 4H block
        await new Promise(r => setTimeout(r, 500))
        continue
      }

      scanLog.push(`${sym}: ✅ Confirmed + 4H ok (${trend.reason}) | ${conf.reason}`)

      // Re-fetch price at EXACT moment of execution
      // prices[sym] was fetched at start of run — could be 2-3 minutes old
      // For accurate entry, get fresh price right now
      let actualEntryPrice = prices[sym] || pending.price
      const freshPrice = await getOKXPrice(sym)
      if (freshPrice) {
        actualEntryPrice = freshPrice
        prices[sym] = freshPrice // update for SL/TP checks too
      }

      const phasePriceDiff = Math.abs(actualEntryPrice - pending.price) / pending.price * 100
      scanLog.push(`${sym}: Fresh price @ ${actualEntryPrice.toFixed(4)} (Phase1: ${pending.price.toFixed(4)}, diff: ${phasePriceDiff.toFixed(2)}%)`)

      if (state.positions.length < 3) {
        const res = openPosition(
          state, pending.dir, actualEntryPrice, actualSL, actualTP,
          state.portfolio.defaultLev || 10, sym
        )
        if (res === 'ok') {
          scanLog.push(`${sym}: 🚀 OPENED ${pending.dir} @ ${actualEntryPrice.toFixed(4)} | SL: ${actualSL.toFixed(4)} | TP: ${actualTP.toFixed(4)} | R:R 1:2`)
        } else {
          scanLog.push(`${sym}: Open failed (${res}) — added to setup backlog`)
          if (!state.setups.some(s => s.sym === sym)) {
            state.setups.push({
              id: state.nextId++, sym,
              side: pending.dir, lev: state.portfolio.defaultLev || 10,
              ep: actualEntryPrice, sl: actualSL, tp: actualTP,
              reason: `CVD:${pending.cvdType} OI:${pending.oiTrend}`,
              time: Date.now()
            })
          }
        }
      } else {
        scanLog.push(`${sym}: Max positions reached — added to setup backlog`)
        if (!state.setups.some(s => s.sym === sym)) {
          state.setups.push({
            id: state.nextId++, sym,
            side: pending.dir, lev: state.portfolio.defaultLev || 10,
            ep: actualEntryPrice, sl: actualSL, tp: actualTP,
            reason: `CVD:${pending.cvdType} OI:${pending.oiTrend}`,
            time: Date.now()
          })
        }
      }
      delete state.pendingSignals[sym]
    } else {
      scanLog.push(`${sym}: ⏳ Pending ${pending.dir} — candle ${pending.candleCount}/${MAX_CANDLE_WAIT} | ${conf.reason}`)
    }

    await new Promise(r => setTimeout(r, 500))
  }

  // ── Step 4: Scan for new Phase 1 signals ─
  for (const sym of watchlist) {
    if (symAlreadyActive(state, sym)) {
      scanLog.push(`${sym}: skipped — position open`)
      continue
    }
    if (state.pendingSignals[sym]) {
      continue
    }

    // TREND FOLLOW MODE — use different detection logic
    if (ENTRY_MODE === 'trendfollow') {
      const tfsig = await detectTrendFollow(sym)
      if (tfsig) {
        const freshPrice = await getOKXPrice(sym) || tfsig.price
        const slDist  = Math.abs(tfsig.price - tfsig.sl)
        const freshSL = tfsig.dir === 'SHORT' ? freshPrice + slDist : freshPrice - slDist
        const freshTP = tfsig.dir === 'SHORT'
          ? freshPrice - slDist * (parseFloat(tfsig.rr)||2.5)
          : freshPrice + slDist * (parseFloat(tfsig.rr)||2.5)
        if (state.positions.length < 3) {
          const res = openPosition(state, tfsig.dir, freshPrice, freshSL, freshTP, state.portfolio.defaultLev || 10, sym)
          if (res === 'ok') {
            scanLog.push(`${sym}: 📈 TrendFollow ${tfsig.dir} @ ${freshPrice.toFixed(4)} | ${tfsig.reason}`)
          }
        } else {
          scanLog.push(`${sym}: 📈 TrendFollow signal ${tfsig.dir} — max positions reached`)
        }
      } else {
        scanLog.push(`${sym}: no signal`)
      }
      await new Promise(r => setTimeout(r, 400))
      continue
    }

    const bars = await getOKXBars(sym, '1H', 100)
    if (!bars || bars.length < 20) {
      scanLog.push(`${sym}: fetch failed`)
      continue
    }

    const sig = await detectPhase1(sym, bars)

    if (sig) {
      if (sig.isLimit) {
        // LIMIT MODE: check if price already at/past limit level — execute immediately
        const curPrice = prices[sym] || sig.marketPrice
        const triggered = sig.dir === 'LONG'
          ? curPrice <= sig.price  // price dipped to our limit
          : curPrice >= sig.price  // price rallied to our limit

        if (triggered && state.positions.length < 3 && !symAlreadyActive(state, sym)) {
          const res = openPosition(state, sig.dir, sig.price, sig.sl, sig.tp, state.portfolio.defaultLev || 10, sym)
          if (res === 'ok') {
            scanLog.push(`${sym}: 🎯 Limit ${sig.dir} TRIGGERED @ ${sig.price.toFixed(4)} | SL:${sig.sl.toFixed(4)} | R:R 1:${sig.rr}`)
          }
        } else {
          // Store as pending limit — check next run
          state.pendingSignals[sym] = {
            dir: sig.dir, price: sig.price, sl: sig.sl, tp: sig.tp,
            rr: sig.rr, cvdType: sig.cvdType, oiTrend: sig.oiTrend,
            vpvrZone: sig.vpvrZone, fr: sig.fr,
            isLimit: true, candleCount: 1, detectedAt: runStart,
            cvd1hOk: sig.cvd1hOk, found5m: sig.found5m
          }
          const cvdLbl  = sig.cvd1hOk ? '✅CVD1H' : '⚠CVD1H'
          const f5mLbl  = sig.found5m ? '5m✅' : '5m⏳'
          scanLog.push(`${sym}: ⏳ Limit ${sig.dir} pending @ ${sig.price.toFixed(4)} (market: ${(sig.marketPrice||0).toFixed(4)}) | R:R 1:${sig.rr} | ${cvdLbl} ${f5mLbl}`)
        }
      } else {
        // CONFIRMATION MODE: save pending signal, wait for confirmation
        const freshPriceP1 = await getOKXPrice(sym) || sig.price
        if (freshPriceP1 !== sig.price) prices[sym] = freshPriceP1
        const slDistP1 = Math.abs(sig.price - sig.sl)
        const freshSL  = sig.dir === 'SHORT' ? freshPriceP1 + slDistP1 : freshPriceP1 - slDistP1
        const freshTP  = sig.dir === 'SHORT' ? freshPriceP1 - slDistP1 * 2 : freshPriceP1 + slDistP1 * 2
        state.pendingSignals[sym] = {
          dir: sig.dir, price: freshPriceP1, sl: freshSL, tp: freshTP,
          rr: sig.rr, cvdType: sig.cvdType, oiTrend: sig.oiTrend,
          vpvrZone: sig.vpvrZone, fr: sig.fr,
          candleCount: 1, detectedAt: runStart
        }
        scanLog.push(`${sym}: ⚡ Phase 1 SIGNAL ${sig.dir} @ ${freshPriceP1.toFixed(4)} | CVD:${sig.cvdType} OI:${sig.oiTrend} VPVR:${sig.vpvrZone} | Waiting confirmation (1/${MAX_CANDLE_WAIT})`)
      }
    } else {
      scanLog.push(`${sym}: no signal`)
    }

    await new Promise(r => setTimeout(r, 600))
  }

  // ── Step 5: Update equity ─────────────────
  const upnl = state.positions.reduce((s, t) => s + (t.upnl || 0), 0)
  state.portfolio.equity = state.portfolio.balance + upnl

// ── Step 6: Append run log ────────────────
  state.log.unshift({
    time:      runStart,
    balance:   state.portfolio.balance.toFixed(2),
    equity:    state.portfolio.equity.toFixed(2),
    positions: state.positions.length,
    pending:   Object.keys(state.pendingSignals).length,
    scan:      scanLog
  })
  if (state.log.length > 48) state.log.length = 48

  // ── Step 7: Write lock + save to JSONBin ─
  // Set a lock timestamp so bot HTML knows val.town just wrote
  // Bot HTML reads this and skips auto-save for 60 seconds after val.town run
  state._valTownLastRun = Date.now()
  await saveState(state)

  console.log(`[${runStart}] Done. Balance: $${state.portfolio.balance.toFixed(2)} | Equity: $${state.portfolio.equity.toFixed(2)} | Positions: ${state.positions.length} | Pending: ${Object.keys(state.pendingSignals).length}`)
  console.log("Scan:", scanLog)
}

// Run main
main().then(() => {
  console.log('[FuturesBot] Scan complete')
  process.exit(0)
}).catch(e => {
  console.error('[FuturesBot] Error:', e)
  process.exit(1)
})
