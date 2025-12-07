const { format, intervalToDuration } = require('date-fns');
const NodeRSA = require('node-rsa');
const { webcrypto } = require('crypto');
const rsaKeys = require('./rsaKeys');

const crypto = globalThis.crypto || webcrypto;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BASE_URL = 'https://app.xtotoro.com/app/';

const encryptRequestContent = (req) => {
  const rsa = new NodeRSA(rsaKeys.privateKey);
  rsa.setOptions({ encryptionScheme: 'pkcs1' });
  const reqStr = JSON.stringify(req);
  // NodeRSA 在部分运行环境要求入参必须是 Buffer，否则会抛出 “data must be a node Buffer”
  return rsa.encrypt(Buffer.from(reqStr, 'utf-8'), 'base64');
};

const generateMac = async (stuNumber) => {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stuNumber));
  const hashArray = Array.from(new Uint8Array(hash));
  const hashHex = hashArray.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return hashHex.substring(0, 32);
};

/** 正态分布随机数生成 */
const normalRandom = (mean, std) => {
  let u = 0;
  let v = 0;
  let w = 0;
  let c = 0;
  let result = mean;
  do {
    u = Math.random() * 2 - 1;
    v = Math.random() * 2 - 1;
    w = u * u + v * v;
    c = Math.sqrt((-2 * Math.log(w)) / w);
    result = mean + u * c * std;
  } while (w === 0 || w >= 1 || result < mean - 3 * std || result > mean + 3 * std);
  return result;
};

const formatNumber = (num) => {
  if (!num) return '00';
  if (num >= 0 && num <= 9) return `0${num}`;
  return String(num);
};

const timeUtil = {
  getHHmmss: (duration) =>
    `${formatNumber(duration.hours)}:${formatNumber(duration.minutes)}:${formatNumber(duration.seconds)}`,
};

const BEIJING_OFFSET_MINUTES = 8 * 60;
const offsetDiffMs = () => {
  const currentOffsetMinutes = -new Date().getTimezoneOffset();
  return (BEIJING_OFFSET_MINUTES - currentOffsetMinutes) * 60 * 1000;
};

const parseCustomEndTime = (customEndTime) => {
  if (!customEndTime) return null;
  if (customEndTime instanceof Date) return customEndTime;
  const normalized = String(customEndTime).trim().replace(' ', 'T');
  if (!normalized) return null;

  const withSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalized)
    ? `${normalized}:00`
    : normalized;
  const withZone = /([+-]\d{2}:?\d{2}|Z)$/i.test(withSeconds)
    ? withSeconds
    : `${withSeconds}+08:00`;

  const parsed = new Date(withZone);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const parseStartDate = (startDate) => {
  if (!startDate) return null;
  if (startDate instanceof Date) return startDate;
  const normalized = String(startDate).trim();
  if (!normalized) return null;
  const withTime = /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? `${normalized}T00:00:00` : normalized;
  const withZone = /([+-]\d{2}:?\d{2}|Z)$/i.test(withTime) ? withTime : `${withTime}+08:00`;
  const parsed = new Date(withZone);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const buildCustomEndFromSlot = (customDate, customPeriod) => {
  if (!customDate || !customPeriod) return null;
  const dateStr = String(customDate).trim();
  const slot = String(customPeriod).toUpperCase();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const slotRange =
    slot === 'AM'
      ? { start: '07:30:00', end: '11:30:00' }
      : slot === 'PM'
        ? { start: '13:30:00', end: '21:30:00' }
        : null;
  if (!slotRange) return null;
  const start = new Date(`${dateStr}T${slotRange.start}+08:00`);
  const end = new Date(`${dateStr}T${slotRange.end}+08:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;
  const rangeMs = end.getTime() - start.getTime();
  const randomMs = Math.floor(Math.random() * rangeMs);
  return new Date(start.getTime() + randomMs);
};

const formatPointToAMap = (point) => [Number(point.longitude), Number(point.latitude)];
const formatRouteToAMap = (route) => route.map((point) => formatPointToAMap(point));

const distanceBetweenPoints = (pointA, pointB) => {
  const d1 = 0.0174532925194329;
  let [d2, d3] = pointA;
  let [d4, d5] = pointB;
  d2 *= d1;
  d3 *= d1;
  d4 *= d1;
  d5 *= d1;
  const d6 = Math.sin(d2);
  const d7 = Math.sin(d3);
  const d8 = Math.cos(d2);
  const d9 = Math.cos(d3);
  const d10 = Math.sin(d4);
  const d11 = Math.sin(d5);
  const d12 = Math.cos(d4);
  const d13 = Math.cos(d5);
  const s11 = d9 * d8;
  const s12 = d9 * d6;
  const s13 = d7;
  const s21 = d13 * d12;
  const s22 = d13 * d10;
  const s23 = d11;
  const d14 = Math.sqrt((s11 - s21) * (s11 - s21) + (s12 - s22) * (s12 - s22) + (s13 - s23) * (s13 - s23));
  return Math.asin(d14 / 2) * 1.2740015798544e7;
};

const distanceOfLine = (line) => {
  let distance = 0;
  for (let i = 0; i < line.length - 1; i += 1) {
    const pointA = line[i];
    const pointB = line[i + 1];
    distance += distanceBetweenPoints(pointA, pointB);
  }
  return distance;
};

const generateRoute = (distance, taskToday) => {
  const std = 1 / 50000;
  const addDeviation = (point) => point.map((plot) => normalRandom(plot, std));
  const addPoints = (pointA, pointB) => {
    const stepLength = 0.0001;
    const stepLengthnum = Number(stepLength);
    const vx = pointB[0] - pointA[0];
    const vy = pointB[1] - pointA[1];
    const norm = Math.hypot(vx, vy);
    const unit = [vx / norm, vy / norm];
    const numberOfPoints = Math.floor(norm / Number(stepLength));
    const points = [pointA];
    for (let i = 1; i < numberOfPoints; i += 1) {
      const pointX = pointA[0] + i * stepLengthnum * unit[0];
      const pointY = pointA[1] + i * stepLengthnum * unit[1];
      points.push([pointX, pointY]);
    }
    return points;
  };

  const combinePoints = () => {
    const { pointList } = taskToday;
    if (!pointList[0].latitude) throw new Error('任务为空');
    const route = formatRouteToAMap(pointList);
    const combined = [];
    for (let index = 0; index < route.length; index += 1) {
      if (index === route.length - 1) {
        combined.push(route[index]);
        break;
      }
      const pointA = route[index];
      const pointB = route[index + 1];
      addPoints(pointA, pointB).forEach((pt) => combined.push(pt));
    }
    return combined;
  };

  const trimRoute = (route) => {
    let r = 0;
    const oriI = Math.floor(Math.random() * route.length);
    let i = oriI;
    const points = [addDeviation(route[oriI])];
    const distanceM = Number(distance) * 1000;
    while (r < distanceM) {
      const point = addDeviation(route[i]);
      points.push(point);
      r = distanceOfLine(points);
      i += 1;
      if (i >= route.length - 2) {
        i = 0;
      }
    }
    return { points, distance: r };
  };

  const routeAddedPoints = combinePoints();
  const trimmedRoute = trimRoute(routeAddedPoints);
  return {
    mockRoute: trimmedRoute.points.map((xy) => ({
      longitude: xy[0].toFixed(6),
      latitude: xy[1].toFixed(6),
    })),
    distance: (trimmedRoute.distance / 1000).toFixed(2),
  };
};

const generateRunReq = async ({
  distance,
  routeId,
  taskId,
  token,
  schoolId,
  stuNumber,
  phoneNumber,
  minTime,
  maxTime,
  customEndTime,
  startDate,
  customDate,
  customPeriod,
}) => {
  const minSecond = Number(minTime) * 60;
  const maxSecond = Number(maxTime) * 60;
  const avgSecond = (minSecond + maxSecond) / 2;
  const stdSecond = Math.max(5, (maxSecond - minSecond) / 6);
  const midSecond = Math.floor((minSecond + maxSecond) / 2);
  const sampleWait = () => Math.floor(normalRandom(avgSecond, stdSecond));

  let waitSecond = sampleWait();
  let tries = 0;
  // 保证至少在区间后半段，若采样落在中值前则重采样几次
  while (waitSecond < midSecond && tries < 5) {
    waitSecond = sampleWait();
    tries += 1;
  }
  if (waitSecond < midSecond) {
    const jitter = Math.floor(Math.random() * Math.max(10, maxSecond - midSecond));
    waitSecond = midSecond + jitter;
  }
  waitSecond = Math.min(maxSecond, Math.max(midSecond, waitSecond));
  const diffMs = offsetDiffMs();
  const now = new Date();
  const nowLocal = new Date(now.getTime() + diffMs);
  const rawCustomEnd =
    parseCustomEndTime(customEndTime) || buildCustomEndFromSlot(customDate, customPeriod);
  const parsedCustomEnd = rawCustomEnd ? new Date(rawCustomEnd.getTime() + diffMs) : null;
  const semesterStart = parseStartDate(startDate);

  const defaultLocalStart = new Date(now.getTime() + diffMs);
  const defaultLocalEnd = new Date(now.getTime() + waitSecond * 1000 + diffMs);

  if (parsedCustomEnd) {
    if (parsedCustomEnd > nowLocal) {
      throw new Error('customEndTime 不可晚于当前时间');
    }
    if (semesterStart) {
      const semesterStartLocal = new Date(semesterStart.getTime() + diffMs);
      if (parsedCustomEnd < semesterStartLocal) {
        throw new Error('customEndTime 早于本学期开始时间');
      }
    }
  }

  const endTime = parsedCustomEnd ?? defaultLocalEnd;
  const startTime = parsedCustomEnd
    ? new Date(endTime.getTime() - waitSecond * 1000)
    : defaultLocalStart;

  const originalDistanceNum = Number(distance);
  const randomIncrement = Math.random() * 0.05 + 0.01;
  const adjustedDistanceNum = originalDistanceNum + randomIncrement;
  const adjustedDistance = adjustedDistanceNum.toFixed(2);

  const avgSpeed = (adjustedDistanceNum / (waitSecond / 3600)).toFixed(2);
  const duration = intervalToDuration({ start: startTime, end: endTime });
  const mac = await generateMac(stuNumber);
  const runDateStr = format(endTime, 'yyyy-MM-dd');
  const todayStr = format(nowLocal, 'yyyy-MM-dd');
  const isBackfill = Boolean(parsedCustomEnd && runDateStr !== todayStr);
  const evaluateDate = isBackfill ? runDateStr : format(endTime, 'yyyy-MM-dd HH:mm:ss');
  const submitDate = isBackfill ? runDateStr : todayStr;
  const consume = Math.round(adjustedDistanceNum * 67.34).toString();

  const req = {
    LocalSubmitReason: isBackfill ? 'offline-backfill' : '',
    avgSpeed,
    baseStation: '',
    endTime: format(endTime, 'HH:mm:ss'),
    evaluateDate,
    fitDegree: '1',
    flag: '1',
    headImage: '',
    ifLocalSubmit: isBackfill ? '1' : '0',
    km: adjustedDistance,
    mac,
    phoneInfo: '$CN11/iPhone15,4/17.4.1',
    phoneNumber: phoneNumber || '',
    pointList: '',
    routeId,
    runType: '0',
    runTimeType: '0',
    sensorString: '',
    startTime: format(startTime, 'HH:mm:ss'),
    steps: `${1000 + Math.floor(Math.random() * 1000)}`,
    stuNumber,
    submitDate,
    taskId,
    token,
    usedTime: timeUtil.getHHmmss(duration),
    version: '1.2.14',
    consume,
    warnFlag: '0',
    warnType: '0',
    faceData: '',
  };
  return { req, endTime: new Date(Number(now) + waitSecond * 1000), adjustedDistance };
};

const baseHeaders = {
  Connection: 'keep-alive',
  'Accept-Encoding': 'gzip, deflate, br',
  Accept: 'application/json',
  Host: 'app.xtotoro.com',
  'User-Agent': 'TotoroSchool/1.2.14 (iPhone; iOS 17.4.1; Scale/3.00)',
};

const postEncrypted = async (path, bodyObj) => {
  const encrypted = encryptRequestContent(bodyObj);
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { ...baseHeaders, 'Content-Type': 'text/plain; charset=utf-8' },
    body: encrypted,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`上游接口 ${path} 返回 ${res.status}: ${text}`);
  return JSON.parse(text);
};

const postJson = async (path, bodyObj) => {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { ...baseHeaders, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(bodyObj),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`上游接口 ${path} 返回 ${res.status}: ${text}`);
  return JSON.parse(text);
};

async function executeRunTask(userData) {
  console.log('[Runner] 开始执行任务', JSON.stringify(userData));
  if (!userData?.session || !userData?.runPoint) {
    throw new Error('任务数据缺失 session 或 runPoint');
  }

  const { session, runPoint, mileage, minTime, maxTime, customEndTime, customDate, customPeriod } =
    userData;
  const basicReq = {
    campusId: session.campusId,
    schoolId: session.schoolId,
    stuNumber: session.stuNumber,
    token: session.token,
  };

  const { req, adjustedDistance } = await generateRunReq({
    distance: mileage,
    routeId: runPoint.pointId,
    taskId: runPoint.taskId,
    token: session.token,
    schoolId: session.schoolId,
    stuNumber: session.stuNumber,
    phoneNumber: session.phoneNumber,
    minTime,
    maxTime,
    customEndTime,
    startDate: userData.startDate,
    customDate,
    customPeriod,
  });

  await postEncrypted('sunrun/getRunBegin', basicReq);
  const exercisesRes = await postEncrypted('platform/recrecord/sunRunExercises', req);
  if (!exercisesRes?.scantronId) {
    throw new Error(`sunRunExercises 缺少 scantronId: ${JSON.stringify(exercisesRes)}`);
  }

  const runRoute = generateRoute(adjustedDistance, runPoint);
  await postJson('platform/recrecord/sunRunExercisesDetail', {
    pointList: runRoute.mockRoute,
    scantronId: exercisesRes.scantronId,
    stuNumber: session.stuNumber,
    token: session.token,
  });

  return `成功提交记录，距离 ${runRoute.distance} km，配速 ${req.avgSpeed}，用时 ${req.usedTime}`;
}

module.exports = { executeRunTask };
