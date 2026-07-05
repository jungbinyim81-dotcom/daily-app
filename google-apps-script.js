// ============================================
// Google Apps Script - 일일 체크리스트 API v3 (통계 지원)
// ============================================
// v3 변경: getChecklistRange(기간 조회, 통계용) 추가 / 구글 캘린더 연동 제거
// 업데이트 방법: script.google.com에서 기존 프로젝트 코드 전체 교체 후
//   배포 → 배포 관리 → 연필 아이콘 → 버전 "새 버전" → 배포 (URL 유지됨)
// ============================================
// 이 코드를 구글 시트의 Apps Script 편집기에 붙여넣으세요.
//
// 설정 방법:
// 1. Google Sheets에서 새 스프레드시트 생성 ("일일체크리스트")
// 2. 확장 프로그램 → Apps Script 클릭
// 3. 이 코드 전체를 붙여넣기
// 4. 배포 → 새 배포 → 웹 앱 선택
//    - 실행 사용자: 나
//    - 액세스 권한: 모든 사용자 (또는 본인만)
// 5. 배포 후 나오는 URL을 PWA의 설정에 입력
// ============================================

// 시트 이름 상수
const CHECKLIST_SHEET = '체크리스트';
const MONTHLY_PLAN_SHEET = '월계획';

/**
 * 초기 시트 구조 세팅 (최초 1회 실행)
 */
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 체크리스트 시트 (8열: 날짜, 항목명, 완료여부, 타입, 순서, ID, 마감시간, 우선순위)
  let clSheet = ss.getSheetByName(CHECKLIST_SHEET);
  if (!clSheet) {
    clSheet = ss.insertSheet(CHECKLIST_SHEET);
    clSheet.getRange('A1:H1').setValues([['날짜', '항목명', '완료여부', '타입', '순서', 'ID', '마감시간', '우선순위']]);
    clSheet.getRange('A1:H1').setFontWeight('bold');
    clSheet.setFrozenRows(1);
  }

  // 월계획 시트
  let mpSheet = ss.getSheetByName(MONTHLY_PLAN_SHEET);
  if (!mpSheet) {
    mpSheet = ss.insertSheet(MONTHLY_PLAN_SHEET);
    mpSheet.getRange('A1:E1').setValues([['연월', '항목명', '완료여부', '순서', 'ID']]);
    mpSheet.getRange('A1:E1').setFontWeight('bold');
    mpSheet.setFrozenRows(1);
  }
}

/**
 * 고유 ID 생성
 */
function generateId() {
  return Utilities.getUuid().substring(0, 8);
}

/**
 * GET 요청 처리
 */
function doGet(e) {
  const action = e.parameter.action;
  let result;

  try {
    switch (action) {
      case 'getChecklist':
        result = getChecklist(e.parameter.date);
        break;
      case 'getChecklistRange':
        result = getChecklistRange(e.parameter.start, e.parameter.end);
        break;
      case 'getMonthlyPlan':
        result = getMonthlyPlan(e.parameter.yearMonth);
        break;
      case 'saveChecklist':
        result = saveChecklist(e.parameter.date, JSON.parse(e.parameter.items));
        break;
      case 'saveMonthlyPlan':
        result = saveMonthlyPlan(e.parameter.yearMonth, JSON.parse(e.parameter.items));
        break;
      case 'ping':
        result = { ok: true };
        break;
      default:
        result = { error: 'Unknown action: ' + action };
    }
  } catch (err) {
    result = { error: err.message };
  }

  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * POST 요청 처리
 */
function doPost(e) {
  let result;

  try {
    const data = JSON.parse(e.postData.contents);
    const action = data.action;

    switch (action) {
      case 'saveChecklist':
        result = saveChecklist(data.date, data.items);
        break;
      case 'saveMonthlyPlan':
        result = saveMonthlyPlan(data.yearMonth, data.items);
        break;
      default:
        result = { error: 'Unknown action: ' + action };
    }
  } catch (err) {
    result = { error: err.message };
  }

  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * 해당 날짜의 체크리스트 가져오기
 */
function getChecklist(dateStr) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CHECKLIST_SHEET);

  if (!sheet || sheet.getLastRow() < 2) {
    return { date: dateStr, items: [] };
  }

  const lastCol = Math.max(sheet.getLastColumn(), 8);
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, lastCol).getValues();
  const items = data
    .filter(row => {
      if (!row[0]) return false;
      const rowDate = Utilities.formatDate(new Date(row[0]), Session.getScriptTimeZone(), 'yyyy-MM-dd');
      return rowDate === dateStr;
    })
    .map(row => ({
      name: row[1],
      done: row[2] === true || row[2] === 'TRUE',
      type: row[3] || '추가',
      order: row[4],
      id: row[5],
      deadline: row[6] ? (row[6] instanceof Date ? Utilities.formatDate(row[6], Session.getScriptTimeZone(), 'HH:mm') : String(row[6])) : null,
      priority: row[7] || null
    }))
    .sort((a, b) => {
      const pOrder = { A: 1, B: 2, C: 3 };
      const pa = pOrder[a.priority] || 4;
      const pb = pOrder[b.priority] || 4;
      if (pa !== pb) return pa - pb;
      return (a.order || 0) - (b.order || 0);
    });

  return { date: dateStr, items: items };
}

/**
 * 기간 체크리스트 가져오기 (통계용) — start~end 날짜의 모든 항목을 날짜별로 묶어 반환
 */
function getChecklistRange(startStr, endStr) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CHECKLIST_SHEET);

  if (!sheet || sheet.getLastRow() < 2) {
    return { start: startStr, end: endStr, days: {} };
  }

  const lastCol = Math.max(sheet.getLastColumn(), 8);
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, lastCol).getValues();
  const days = {};

  data.forEach(row => {
    if (!row[0]) return;
    const rowDate = Utilities.formatDate(new Date(row[0]), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    if (rowDate < startStr || rowDate > endStr) return;

    if (!days[rowDate]) days[rowDate] = [];
    days[rowDate].push({
      name: row[1],
      done: row[2] === true || row[2] === 'TRUE',
      type: row[3] || '추가',
      order: row[4],
      id: row[5],
      deadline: row[6] ? (row[6] instanceof Date ? Utilities.formatDate(row[6], Session.getScriptTimeZone(), 'HH:mm') : String(row[6])) : null,
      priority: row[7] || null
    });
  });

  return { start: startStr, end: endStr, days: days };
}

/**
 * 체크리스트 저장 (해당 날짜 전체 덮어쓰기, 8열)
 */
function saveChecklist(dateStr, items) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CHECKLIST_SHEET);

  if (!sheet) {
    return { error: 'Sheet not found. Run setupSheets() first.' };
  }

  // 기존 해당 날짜 데이터 삭제
  if (sheet.getLastRow() >= 2) {
    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
    const rowsToDelete = [];

    for (let i = data.length - 1; i >= 0; i--) {
      if (!data[i][0]) continue;
      const rowDate = Utilities.formatDate(new Date(data[i][0]), Session.getScriptTimeZone(), 'yyyy-MM-dd');
      if (rowDate === dateStr) {
        rowsToDelete.push(i + 2);
      }
    }

    for (const row of rowsToDelete) {
      sheet.deleteRow(row);
    }
  }

  // 새 데이터 추가 (8열)
  if (items.length > 0) {
    const newRows = items.map((item, idx) => [
      dateStr,
      item.name,
      item.done || false,
      item.type || '추가',
      item.order !== undefined ? item.order : idx + 1,
      item.id || generateId(),
      item.deadline || '',
      item.priority || ''
    ]);

    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, 8).setValues(newRows);
  }

  return { success: true, date: dateStr, count: items.length };
}

/**
 * 월 계획 가져오기
 */
function getMonthlyPlan(yearMonth) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(MONTHLY_PLAN_SHEET);

  if (!sheet || sheet.getLastRow() < 2) {
    return { yearMonth: yearMonth, items: [] };
  }

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues();
  const items = data
    .filter(row => row[0] === yearMonth)
    .map(row => ({
      name: row[1],
      done: row[2] === true || row[2] === 'TRUE',
      order: row[3],
      id: row[4]
    }))
    .sort((a, b) => (a.order || 0) - (b.order || 0));

  return { yearMonth: yearMonth, items: items };
}

/**
 * 월 계획 저장 (해당 연월 전체 덮어쓰기)
 */
function saveMonthlyPlan(yearMonth, items) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(MONTHLY_PLAN_SHEET);

  if (!sheet) {
    return { error: 'Monthly plan sheet not found. Run setupSheets() first.' };
  }

  // 기존 해당 연월 데이터 삭제
  if (sheet.getLastRow() >= 2) {
    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
    const rowsToDelete = [];

    for (let i = data.length - 1; i >= 0; i--) {
      if (data[i][0] === yearMonth) {
        rowsToDelete.push(i + 2);
      }
    }

    for (const row of rowsToDelete) {
      sheet.deleteRow(row);
    }
  }

  // 새 데이터 추가
  if (items.length > 0) {
    const newRows = items.map((item, idx) => [
      yearMonth,
      item.name,
      item.done || false,
      item.order !== undefined ? item.order : idx + 1,
      item.id || generateId()
    ]);

    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, 5).setValues(newRows);
  }

  return { success: true, yearMonth: yearMonth, count: items.length };
}

// (구글 캘린더 연동은 v3에서 제거됨 — 통계 분석으로 대체)
