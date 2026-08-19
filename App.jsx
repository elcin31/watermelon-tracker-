import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  Plus,
  Check,
  X,
  ChevronRight,
  ChevronLeft,
  Clock,
  TrendingUp,
  History,
  AlertCircle,
  Loader2,
  RefreshCw,
  PackagePlus,
  CloudOff,
} from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY = "watermelon-stock";

const RIND = "#1F3B2C";
const RIND_DEEP = "#132318";
const RIND_STRIPE = "#3E6B4B";
const FLESH = "#E4483A";
const FLESH_DEEP = "#B92E22";
const SEED = "#22140F";
const CREAM = "#FBF3E4";
const SAND = "#F2E4C8";
const SAND_DEEP = "#E9D6AD";
const JUICE = "#F9C1B8";
const AMBER = "#B08A3E";

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtNum(n, digits = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("ru-RU", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtMoney(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return `${n.toLocaleString("ru-RU", { maximumFractionDigits: 0 })} ₽`;
}

function unitLabel(unit, short = false) {
  if (unit === "kg") return short ? "кг" : "килограмм";
  return short ? "шт" : "штук";
}

function fmtQty(qty, unit) {
  const digits = unit === "kg" ? (qty % 1 !== 0 ? 1 : 0) : 0;
  return `${fmtNum(qty, digits)} ${unitLabel(unit, true)}`;
}

function fmtDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    weekday: "short",
  });
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function fmtDuration(hours) {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return "—";
  if (hours <= 0) return "уже пора";
  const totalMin = Math.round(hours * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} мин`;
  if (m === 0) return `${h} ч`;
  return `${h} ч ${m} мин`;
}

// ---- Core stock math --------------------------------------------------

function allSales(data) {
  return data.shifts.flatMap((s) => s.sales);
}

function totalSold(data) {
  return allSales(data).reduce((acc, s) => acc + s.qty, 0);
}

function currentRemaining(data) {
  if (!data.totalStock) return 0;
  return Math.max(0, data.totalStock.initialQty - totalSold(data));
}

function shiftSold(shift) {
  return shift.sales.reduce((acc, s) => acc + s.qty, 0);
}

function shiftRevenue(shift) {
  return shift.sales.reduce((acc, s) => acc + s.revenue, 0);
}

function shiftRate(shift, nowTs) {
  const opened = new Date(shift.openedAt).getTime();
  const end = shift.status === "closed" && shift.closedAt ? new Date(shift.closedAt).getTime() : nowTs;
  const elapsedH = (end - opened) / (1000 * 60 * 60);
  const sold = shiftSold(shift);
  if (elapsedH <= 0.0167) return null;
  return sold / elapsedH;
}

function shiftRecentRate(shift, nowTs) {
  const windowMs = 30 * 60 * 1000;
  const cutoff = nowTs - windowMs;
  const recentSales = shift.sales.filter((s) => new Date(s.timestamp).getTime() >= cutoff);
  if (recentSales.length === 0) return null;
  const qty = recentSales.reduce((acc, s) => acc + s.qty, 0);
  const oldestTs = Math.min(...recentSales.map((s) => new Date(s.timestamp).getTime()));
  const spanH = Math.max((nowTs - oldestTs) / (1000 * 60 * 60), 5 / 60);
  return qty / spanH;
}

function average(nums) {
  const valid = nums.filter((n) => typeof n === "number" && Number.isFinite(n));
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

// ---------------------------------------------------------------------------
// Storage layer with offline buffering
// (без изменений — теперь window.storage подставляет storageShim.js
// поверх localStorage, вся очередь/pump-логика работает как раньше)
// ---------------------------------------------------------------------------

function useShiftsStore() {
  const [data, setData] = useState(null);
  const [saveStatus, setSaveStatus] = useState("idle");
  const [pendingCount, setPendingCount] = useState(0);

  const confirmedRef = useRef(null);
  const queueRef = useRef([]);
  const writingRef = useRef(false);
  const retryTimer = useRef(null);
  const savedFlashTimer = useRef(null);

  const load = useCallback(async () => {
    try {
      const result = await window.storage.get(STORAGE_KEY, false);
      let initial = { totalStock: null, shifts: [] };
      if (result && result.value) {
        const parsed = JSON.parse(result.value);
        if (parsed && typeof parsed === "object") {
          initial = {
            totalStock: parsed.totalStock ?? null,
            shifts: Array.isArray(parsed.shifts) ? parsed.shifts : [],
          };
        }
      }
      confirmedRef.current = initial;
      setData(initial);
    } catch (e) {
      const initial = { totalStock: null, shifts: [] };
      confirmedRef.current = initial;
      setData(initial);
    }
  }, []);

  useEffect(() => {
    load();
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
      if (savedFlashTimer.current) clearTimeout(savedFlashTimer.current);
    };
  }, [load]);

  const rawWrite = useCallback(async (nextData) => {
    try {
      const result = await window.storage.set(STORAGE_KEY, JSON.stringify(nextData), false);
      return !!result;
    } catch (e) {
      return false;
    }
  }, []);

  const pump = useCallback(async () => {
    if (writingRef.current) return;
    if (queueRef.current.length === 0) return;

    writingRef.current = true;
    setSaveStatus("saving");

    const queueSnapshot = queueRef.current;
    let working = confirmedRef.current;
    for (const applyFn of queueSnapshot) {
      working = applyFn(working);
    }

    const ok = await rawWrite(working);

    if (ok) {
      confirmedRef.current = working;
      queueRef.current = queueRef.current.slice(queueSnapshot.length);
      setPendingCount(queueRef.current.length);
      writingRef.current = false;

      if (queueRef.current.length > 0) {
        pump();
      } else {
        setSaveStatus("saved");
        if (savedFlashTimer.current) clearTimeout(savedFlashTimer.current);
        savedFlashTimer.current = setTimeout(() => setSaveStatus("idle"), 1800);
      }
    } else {
      writingRef.current = false;
      setSaveStatus("offline");
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = setTimeout(() => {
        pump();
      }, 4000);
    }
  }, [rawWrite]);

  const mutate = useCallback(
    (applyFn) => {
      setData((prevData) => {
        if (!prevData) return prevData;
        return applyFn(prevData);
      });
      queueRef.current = [...queueRef.current, applyFn];
      setPendingCount(queueRef.current.length);
      pump();
    },
    [pump]
  );

  const retryNow = useCallback(() => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    pump();
  }, [pump]);

  return {
    data,
    mutate,
    saveStatus,
    hasPending: pendingCount > 0,
    retryNow,
    reload: load,
  };
}

// ---------------------------------------------------------------------------
// Shared UI atoms
// ---------------------------------------------------------------------------

function LoadingScreen() {
  return (
    <div className="wm-root wm-center">
      <div className="wm-loading">
        <Loader2 className="wm-spin" size={28} />
        <span>Открываю прилавок…</span>
      </div>
    </div>
  );
}

function SaveIndicator({ status, onRetry }) {
  if (status === "idle") return null;
  if (status === "saving") {
    return (
      <span className="wm-save-pill wm-save-pill-saving">
        <Loader2 className="wm-spin" size={12} />
        сохраняю
      </span>
    );
  }
  if (status === "saved") {
    return (
      <span className="wm-save-pill wm-save-pill-saved">
        <Check size={12} />
        сохранено
      </span>
    );
  }
  if (status === "offline") {
    return (
      <button type="button" className="wm-save-pill wm-save-pill-offline" onClick={onRetry}>
        <CloudOff size={12} />
        нет сети · повторить
      </button>
    );
  }
  return null;
}

function OfflineBanner({ visible, onRetry }) {
  if (!visible) return null;
  return (
    <div className="wm-offline-banner" role="status">
      <CloudOff size={16} />
      <span>Связи нет. Продажи копятся на телефоне и досохранятся сами.</span>
      <button type="button" className="wm-offline-retry" onClick={onRetry}>
        <RefreshCw size={14} />
        Повторить
      </button>
    </div>
  );
}

function ErrorBanner({ message, onDismiss }) {
  if (!message) return null;
  return (
    <div className="wm-error-banner" role="alert">
      <AlertCircle size={16} />
      <span>{message}</span>
      {onDismiss && (
        <button className="wm-error-dismiss" onClick={onDismiss} aria-label="Скрыть">
          <X size={14} />
        </button>
      )}
    </div>
  );
}

function WatermelonMark({ size = 48 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" aria-hidden="true">
      <path
        d="M50 6C74 6 94 26 94 50C94 74 74 94 50 94C26 94 6 74 6 50C6 26 26 6 50 6Z"
        fill={RIND}
      />
      <path
        d="M50 16C68.5 16 84 31.5 84 50C84 68.5 68.5 84 50 84C31.5 84 16 68.5 16 50C16 31.5 31.5 16 50 16Z"
        fill={CREAM}
      />
      <path
        d="M50 26C63 26 74 37 74 50C74 63 63 74 50 74C37 74 26 63 26 50C26 37 37 26 50 26Z"
        fill={FLESH}
      />
      <circle cx="44" cy="44" r="2.6" fill={SEED} />
      <circle cx="58" cy="47" r="2.6" fill={SEED} />
      <circle cx="49" cy="58" r="2.6" fill={SEED} />
      <circle cx="60" cy="60" r="2.2" fill={SEED} />
      <circle cx="40" cy="56" r="2.2" fill={SEED} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Screen 1: First launch — set up the batch (totalStock)
// ---------------------------------------------------------------------------

function SetupStockScreen({ onSave, busy }) {
  const [unit, setUnit] = useState("kg");
  const [qty, setQty] = useState("");
  const [price, setPrice] = useState("");
  const [touched, setTouched] = useState(false);

  const qtyNum = parseFloat(qty.replace(",", "."));
  const priceNum = parseFloat(price.replace(",", "."));
  const qtyValid = qty !== "" && Number.isFinite(qtyNum) && qtyNum > 0;
  const priceValid = price !== "" && Number.isFinite(priceNum) && priceNum > 0;
  const canSubmit = qtyValid && priceValid && !busy;

  const handleSubmit = () => {
    setTouched(true);
    if (!canSubmit) return;
    onSave({ unit, initialQty: qtyNum, pricePerUnit: priceNum });
  };

  return (
    <div className="wm-root">
      <div className="wm-hero">
        <div className="wm-hero-mark">
          <WatermelonMark size={64} />
        </div>
        <h1 className="wm-hero-title">Новая партия</h1>
        <p className="wm-hero-sub">Заводится один раз — потом просто открываешь смены</p>
      </div>

      <div className="wm-card wm-form-card">
        <div className="wm-field">
          <span className="wm-field-label">Считаем в чём</span>
          <div className="wm-segmented" role="radiogroup" aria-label="Единица измерения">
            <button
              type="button"
              role="radio"
              aria-checked={unit === "kg"}
              className={`wm-seg-btn ${unit === "kg" ? "wm-seg-active" : ""}`}
              onClick={() => setUnit("kg")}
            >
              Килограммы
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={unit === "pcs"}
              className={`wm-seg-btn ${unit === "pcs" ? "wm-seg-active" : ""}`}
              onClick={() => setUnit("pcs")}
            >
              Штуки
            </button>
          </div>
        </div>

        <div className="wm-field">
          <label className="wm-field-label" htmlFor="qty">
            Вся партия, {unitLabel(unit)}
          </label>
          <input
            id="qty"
            type="number"
            inputMode="decimal"
            className="wm-input wm-input-big"
            placeholder={unit === "kg" ? "например, 500" : "например, 100"}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            min="0"
            step="any"
          />
          {touched && !qtyValid && (
            <span className="wm-field-error">Укажи количество больше нуля</span>
          )}
        </div>

        <div className="wm-field">
          <label className="wm-field-label" htmlFor="price">
            Цена за {unit === "kg" ? "кг" : "штуку"}, ₽
          </label>
          <input
            id="price"
            type="number"
            inputMode="decimal"
            className="wm-input wm-input-big"
            placeholder="например, 45"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            min="0"
            step="any"
          />
          {touched && !priceValid && (
            <span className="wm-field-error">Укажи цену больше нуля</span>
          )}
        </div>

        <button
          type="button"
          className="wm-btn wm-btn-primary wm-btn-full wm-btn-tall"
          onClick={handleSubmit}
          disabled={busy}
        >
          {busy ? <Loader2 className="wm-spin" size={20} /> : "Сохранить"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screen 2: Batch exists, no active shift
// ---------------------------------------------------------------------------

function NoActiveShiftScreen({
  data,
  remaining,
  onOpenShift,
  onGoRestock,
  onGoHistory,
  busy,
}) {
  const { totalStock } = data;
  const hasHistory = data.shifts.some((s) => s.status === "closed");
  const soldOut = remaining <= 0;

  return (
    <div className="wm-root">
      <div className="wm-hero">
        <div className="wm-hero-mark">
          <WatermelonMark size={56} />
        </div>
        <h1 className="wm-hero-title">Смена закрыта</h1>
        <p className="wm-hero-sub">
          {fmtMoney(totalStock.pricePerUnit)} / {unitLabel(totalStock.unit, true)}
        </p>
      </div>

      <div className="wm-remaining-card">
        <span className="wm-remaining-label">
          {soldOut ? "Партия распродана" : "Остаток всей партии"}
        </span>
        <div className="wm-remaining-figure">
          <span className="wm-remaining-number">
            {fmtNum(remaining, remaining % 1 !== 0 ? 1 : 0)}
          </span>
          <span className="wm-remaining-unit">{unitLabel(totalStock.unit, true)}</span>
        </div>
        <div className="wm-remaining-bar-track">
          <div
            className="wm-remaining-bar-fill"
            style={{
              width: `${totalStock.initialQty > 0 ? Math.min(100, (remaining / totalStock.initialQty) * 100) : 0}%`,
            }}
          />
        </div>
        <span className="wm-remaining-sub">из {fmtQty(totalStock.initialQty, totalStock.unit)} завезённых</span>
      </div>

      <button
        type="button"
        className="wm-btn wm-btn-primary wm-btn-full wm-btn-tall"
        onClick={onOpenShift}
        disabled={busy || soldOut}
      >
        {busy ? <Loader2 className="wm-spin" size={20} /> : soldOut ? "Партия распродана" : "Открыть смену"}
      </button>

      <div className="wm-secondary-actions">
        <button type="button" className="wm-btn wm-btn-ghost wm-btn-full" onClick={onGoRestock}>
          <PackagePlus size={18} />
          <span>Пополнить партию</span>
        </button>
        {hasHistory && (
          <button type="button" className="wm-link-btn" onClick={onGoHistory}>
            <History size={16} />
            <span>Смотреть прошлые смены</span>
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screen 3: Active shift — sale entry, pace, forecast, sale log, chart
//
// НОВОЕ: этого экрана не было в присланном файле вообще (обрыв случился
// раньше). Написан с нуля под структуру useShiftsStore/shiftRate/
// shiftRecentRate/average, которые уже были определены выше.
// ---------------------------------------------------------------------------

function buildChartSeries(shift) {
  if (shift.sales.length === 0) return [];
  const sorted = [...shift.sales].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
  let running = 0;
  return sorted.map((s) => {
    running += s.qty;
    return {
      t: new Date(s.timestamp).getTime(),
      cumulative: Math.round(running * 100) / 100,
    };
  });
}

function forecastHoursLeft(remainingAfterShift, rate) {
  if (!rate || rate <= 0) return null;
  if (remainingAfterShift <= 0) return 0;
  return remainingAfterShift / rate;
}

function ActiveShiftScreen({
  data,
  shift,
  remaining,
  onAddSale,
  onDeleteSale,
  onCloseShift,
  busy,
  errorMessage,
  onDismissError,
}) {
  const { totalStock } = data;
  const [qty, setQty] = useState("");
  const [touched, setTouched] = useState(false);
  const [nowTs, setNowTs] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNowTs(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  const qtyNum = parseFloat(qty.replace(",", "."));
  const qtyValid = qty !== "" && Number.isFinite(qtyNum) && qtyNum > 0;

  const sold = shiftSold(shift);
  const revenue = shiftRevenue(shift);
  const overallRate = shiftRate(shift, nowTs);
  const recentRate = shiftRecentRate(shift, nowTs);
  const effectiveRate = recentRate ?? overallRate;
  const hoursLeft = forecastHoursLeft(remaining, effectiveRate);

  const ringPct =
    totalStock.initialQty > 0 ? Math.max(0, Math.min(1, remaining / totalStock.initialQty)) : 0;
  const R = 68;
  const C = 2 * Math.PI * R;

  const sortedSales = useMemo(
    () => [...shift.sales].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()),
    [shift.sales]
  );
  const chartData = useMemo(() => buildChartSeries(shift), [shift]);

  const revenuePreview = qtyValid ? qtyNum * totalStock.pricePerUnit : null;

  const handleAdd = () => {
    setTouched(true);
    if (!qtyValid || busy) return;
    if (qtyNum > remaining) return;
    onAddSale(qtyNum);
    setQty("");
    setTouched(false);
  };

  const overStock = touched && qtyValid && qtyNum > remaining;

  return (
    <div className="wm-root">
      <ErrorBanner message={errorMessage} onDismiss={onDismissError} />

      <div className="wm-shift-header">
        <div className="wm-shift-header-info">
          <span className="wm-shift-header-title">Смена идёт</span>
          <span className="wm-shift-header-sub">открыта в {fmtTime(shift.openedAt)}</span>
        </div>
        <WatermelonMark size={36} />
      </div>

      <div className="wm-ring-wrap">
        <svg width="180" height="180" viewBox="0 0 160 160" className="wm-ring-svg">
          <circle className="wm-ring-track" cx="80" cy="80" r={R} />
          <circle
            className="wm-ring-fill"
            cx="80"
            cy="80"
            r={R}
            strokeDasharray={C}
            strokeDashoffset={C * (1 - ringPct)}
          />
        </svg>
        <div className="wm-ring-center">
          <span className="wm-ring-number">{fmtNum(remaining, remaining % 1 !== 0 ? 1 : 0)}</span>
          <span className="wm-ring-unit">{unitLabel(totalStock.unit, true)} осталось</span>
        </div>
      </div>
      <span className="wm-ring-caption">
        из {fmtQty(totalStock.initialQty, totalStock.unit)} всей партии
      </span>

      <div className="wm-stat-grid">
        <div className="wm-stat-card">
          <span className="wm-stat-label">
            <TrendingUp size={13} />
            Продано за смену
          </span>
          <span className="wm-stat-value">{fmtQty(sold, totalStock.unit)}</span>
        </div>
        <div className="wm-stat-card">
          <span className="wm-stat-label">Выручка за смену</span>
          <span className="wm-stat-value">{fmtMoney(revenue)}</span>
        </div>
        <div className="wm-stat-card">
          <span className="wm-stat-label">
            <Clock size={13} />
            Темп
          </span>
          <span className="wm-stat-value">
            {effectiveRate ? `${fmtNum(effectiveRate, 1)} ${unitLabel(totalStock.unit, true)}/ч` : "—"}
          </span>
        </div>
        <div className="wm-stat-card">
          <span className="wm-stat-label">Хватит партии на</span>
          <span className={`wm-stat-value ${hoursLeft !== null && hoursLeft < 1 ? "wm-stat-value-warn" : ""}`}>
            {hoursLeft === null ? "—" : hoursLeft === 0 ? "уже пусто" : fmtDuration(hoursLeft)}
          </span>
        </div>
      </div>

      <div className="wm-card wm-form-card">
        <div className="wm-sale-form">
          <div className="wm-field">
            <label className="wm-field-label" htmlFor="sale-qty">
              Продажа, {unitLabel(totalStock.unit)}
            </label>
            <input
              id="sale-qty"
              type="number"
              inputMode="decimal"
              className="wm-input wm-input-big"
              placeholder={totalStock.unit === "kg" ? "например, 3.5" : "например, 1"}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              min="0"
              step="any"
            />
          </div>
          <button
            type="button"
            className="wm-btn wm-btn-primary wm-sale-add-btn"
            onClick={handleAdd}
            disabled={busy}
            aria-label="Добавить продажу"
          >
            {busy ? <Loader2 className="wm-spin" size={20} /> : <Plus size={22} />}
          </button>
        </div>
        {touched && !qtyValid && (
          <span className="wm-field-error">Укажи количество больше нуля</span>
        )}
        {overStock && (
          <span className="wm-field-error">
            В остатке только {fmtQty(remaining, totalStock.unit)}
          </span>
        )}
        {revenuePreview !== null && !overStock && (
          <span className="wm-sale-revenue-preview">= {fmtMoney(revenuePreview)}</span>
        )}
      </div>

      {chartData.length >= 2 && (
        <div className="wm-chart-card">
          <div className="wm-chart-title">Продажи нарастающим итогом</div>
          <ResponsiveContainer width="100%" height={120}>
            <AreaChart data={chartData} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="wmFleshFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={FLESH} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={FLESH} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <XAxis dataKey="t" hide />
              <YAxis hide domain={[0, "dataMax"]} />
              <Tooltip
                formatter={(value) => [fmtQty(value, totalStock.unit), "продано"]}
                labelFormatter={(t) => fmtTime(t)}
                contentStyle={{
                  borderRadius: 12,
                  border: "none",
                  boxShadow: "0 6px 20px rgba(31,59,44,0.18)",
                  fontSize: 12,
                }}
              />
              <Area
                type="monotone"
                dataKey="cumulative"
                stroke={FLESH}
                strokeWidth={2.5}
                fill="url(#wmFleshFill)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="wm-sale-log-title">
        <span>Лог продаж</span>
        <span className="wm-sale-log-count">{shift.sales.length}</span>
      </div>

      {sortedSales.length === 0 ? (
        <p className="wm-empty-hint">Пока пусто — первая продажа появится здесь</p>
      ) : (
        <div className="wm-sale-list">
          {sortedSales.map((s) => (
            <div className="wm-sale-row" key={s.id}>
              <div className="wm-sale-row-left">
                <span className="wm-sale-row-qty">{fmtQty(s.qty, totalStock.unit)}</span>
                <span className="wm-sale-row-time">{fmtTime(s.timestamp)}</span>
              </div>
              <div className="wm-sale-row-right">
                <span className="wm-sale-row-revenue">{fmtMoney(s.revenue)}</span>
                <button
                  type="button"
                  className="wm-sale-row-delete"
                  onClick={() => onDeleteSale(s.id)}
                  aria-label="Удалить продажу"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        className="wm-btn wm-btn-ghost wm-btn-full wm-close-shift-btn"
        onClick={onCloseShift}
        disabled={busy}
      >
        {busy ? <Loader2 className="wm-spin" size={20} /> : "Закрыть смену"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screen 4: History — list of past (and current) shifts
//
// НОВОЕ: тоже написан с нуля, тем же способом.
// ---------------------------------------------------------------------------

function HistoryScreen({ data, onBack }) {
  const { totalStock } = data;
  const sorted = useMemo(
    () => [...data.shifts].sort((a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime()),
    [data.shifts]
  );

  const totalRevenueAll = data.shifts.reduce((acc, s) => acc + shiftRevenue(s), 0);
  const totalSoldAll = totalSold(data);

  return (
    <div className="wm-root">
      <header className="wm-history-header">
        <button type="button" className="wm-icon-btn" onClick={onBack} aria-label="Назад">
          <ChevronLeft size={22} />
        </button>
        <h1 className="wm-history-title">История смен</h1>
      </header>

      <div className="wm-history-summary">
        <div className="wm-stat-card">
          <span className="wm-stat-label">Продано всего</span>
          <span className="wm-stat-value">{fmtQty(totalSoldAll, totalStock.unit)}</span>
        </div>
        <div className="wm-stat-card">
          <span className="wm-stat-label">Выручка всего</span>
          <span className="wm-stat-value">{fmtMoney(totalRevenueAll)}</span>
        </div>
      </div>

      {sorted.length === 0 ? (
        <p className="wm-empty-hint">Смен пока не было</p>
      ) : (
        <div className="wm-history-list">
          {sorted.map((shift) => {
            const isActive = shift.status !== "closed";
            const sold = shiftSold(shift);
            const revenue = shiftRevenue(shift);
            const rate = !isActive ? shiftRate(shift, Date.now()) : null;
            return (
              <div className="wm-history-card" key={shift.id}>
                <div className="wm-history-card-top">
                  <span className="wm-history-card-date">{fmtDate(todayISOFrom(shift.openedAt))}</span>
                  <span
                    className={`wm-history-card-status ${isActive ? "wm-history-card-status-active" : ""}`}
                  >
                    {isActive ? "идёт" : "закрыта"}
                  </span>
                </div>
                <div className="wm-history-card-row">
                  <span>Время</span>
                  <strong>
                    {fmtTime(shift.openedAt)} — {shift.closedAt ? fmtTime(shift.closedAt) : "сейчас"}
                  </strong>
                </div>
                <div className="wm-history-card-row">
                  <span>Продано</span>
                  <strong>{fmtQty(sold, totalStock.unit)}</strong>
                </div>
                <div className="wm-history-card-row">
                  <span>Выручка</span>
                  <strong>{fmtMoney(revenue)}</strong>
                </div>
                {rate !== null && (
                  <div className="wm-history-card-row">
                    <span>Средний темп</span>
                    <strong>
                      {fmtNum(rate, 1)} {unitLabel(totalStock.unit, true)}/ч
                    </strong>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function todayISOFrom(isoTimestamp) {
  const d = new Date(isoTimestamp);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// Screen: Restock (add to totalStock.initialQty)
// ---------------------------------------------------------------------------

function RestockScreen({ totalStock, onConfirm, onCancel, busy }) {
  const [amount, setAmount] = useState("");
  const [touched, setTouched] = useState(false);

  const amtNum = parseFloat(amount.replace(",", "."));
  const valid = amount !== "" && Number.isFinite(amtNum) && amtNum > 0;

  const handleConfirm = () => {
    setTouched(true);
    if (!valid || busy) return;
    onConfirm(amtNum);
  };

  return (
    <div className="wm-root">
      <header className="wm-history-header">
        <button type="button" className="wm-icon-btn" onClick={onCancel} aria-label="Назад">
          <ChevronLeft size={22} />
        </button>
        <h1 className="wm-history-title">Пополнить партию</h1>
      </header>

      <div className="wm-card wm-form-card">
        <div className="wm-field">
          <label className="wm-field-label" htmlFor="restock-amount">
            Добавить, {unitLabel(totalStock.unit)}
          </label>
          <input
            id="restock-amount"
            type="number"
            inputMode="decimal"
            className="wm-input wm-input-big"
            placeholder={totalStock.unit === "kg" ? "например, 100" : "например, 50"}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            min="0"
            step="any"
          />
          {touched && !valid && (
            <span className="wm-field-error">Укажи количество больше нуля</span>
          )}
        </div>

        <button
          type="button"
          className="wm-btn wm-btn-primary wm-btn-full wm-btn-tall"
          onClick={handleConfirm}
          disabled={busy}
        >
          {busy ? <Loader2 className="wm-spin" size={20} /> : "Добавить к остатку"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root App — все 4 экрана подключены: setup → home ⇄ shift / restock /
// history. mutate() всегда работает с последним confirmed-состоянием
// через очередь (offline-safe), поэтому сюда просто дописываются новые
// applyFn — открыть/закрыть смену, продажа, удаление продажи.
// ---------------------------------------------------------------------------

function App() {
  const { data, mutate, saveStatus, retryNow } = useShiftsStore();
  const [view, setView] = useState("home");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);

  if (!data) return <LoadingScreen />;

  const remaining = currentRemaining(data);
  const activeShift = data.shifts.find((s) => s.status !== "closed") ?? null;

  const handleSetupSave = (totalStock) => {
    mutate((prev) => ({ ...prev, totalStock }));
  };

  const handleRestockConfirm = (amount) => {
    mutate((prev) => ({
      ...prev,
      totalStock: {
        ...prev.totalStock,
        initialQty: prev.totalStock.initialQty + amount,
      },
    }));
    setView("home");
  };

  const handleOpenShift = () => {
    if (activeShift) {
      setView("shift");
      return;
    }
    mutate((prev) => ({
      ...prev,
      shifts: [
        ...prev.shifts,
        { id: uid(), status: "open", openedAt: new Date().toISOString(), closedAt: null, sales: [] },
      ],
    }));
    setView("shift");
  };

  const handleAddSale = (qty) => {
    if (!activeShift) return;
    if (qty > remaining) {
      setErrorMessage("Столько в остатке нет — проверь количество");
      return;
    }
    setErrorMessage(null);
    mutate((prev) => ({
      ...prev,
      shifts: prev.shifts.map((s) =>
        s.id === activeShift.id
          ? {
              ...s,
              sales: [
                ...s.sales,
                {
                  id: uid(),
                  qty,
                  revenue: qty * prev.totalStock.pricePerUnit,
                  timestamp: new Date().toISOString(),
                },
              ],
            }
          : s
      ),
    }));
  };

  const handleDeleteSale = (saleId) => {
    if (!activeShift) return;
    mutate((prev) => ({
      ...prev,
      shifts: prev.shifts.map((s) =>
        s.id === activeShift.id ? { ...s, sales: s.sales.filter((sale) => sale.id !== saleId) } : s
      ),
    }));
  };

  const handleCloseShift = () => {
    if (!activeShift) return;
    mutate((prev) => ({
      ...prev,
      shifts: prev.shifts.map((s) =>
        s.id === activeShift.id ? { ...s, status: "closed", closedAt: new Date().toISOString() } : s
      ),
    }));
    setView("home");
  };

  return (
    <>
      <OfflineBanner visible={saveStatus === "offline"} onRetry={retryNow} />

      {!data.totalStock && <SetupStockScreen onSave={handleSetupSave} busy={busy} />}

      {data.totalStock && view === "home" && (
        <NoActiveShiftScreen
          data={data}
          remaining={remaining}
          onOpenShift={handleOpenShift}
          onGoRestock={() => setView("restock")}
          onGoHistory={() => setView("history")}
          busy={busy}
        />
      )}

      {data.totalStock && view === "shift" && activeShift && (
        <ActiveShiftScreen
          data={data}
          shift={activeShift}
          remaining={remaining}
          onAddSale={handleAddSale}
          onDeleteSale={handleDeleteSale}
          onCloseShift={handleCloseShift}
          busy={busy}
          errorMessage={errorMessage}
          onDismissError={() => setErrorMessage(null)}
        />
      )}

      {/* Защита от гонки: если смену закрыли на другом устройстве, пока
          мы были на этом экране, activeShift станет null раньше, чем
          view переключится обратно на "home". Без этого блока — пустой
          экран без выхода. */}
      {data.totalStock && view === "shift" && !activeShift && (
        <NoActiveShiftScreen
          data={data}
          remaining={remaining}
          onOpenShift={handleOpenShift}
          onGoRestock={() => setView("restock")}
          onGoHistory={() => setView("history")}
          busy={busy}
        />
      )}

      {data.totalStock && view === "restock" && (
        <RestockScreen
          totalStock={data.totalStock}
          onConfirm={handleRestockConfirm}
          onCancel={() => setView("home")}
          busy={busy}
        />
      )}

      {data.totalStock && view === "history" && (
        <HistoryScreen data={data} onBack={() => setView("home")} />
      )}

      <div style={{ position: "fixed", bottom: 12, right: 12 }}>
        <SaveIndicator status={saveStatus} onRetry={retryNow} />
      </div>
    </>
  );
}

export default App;
