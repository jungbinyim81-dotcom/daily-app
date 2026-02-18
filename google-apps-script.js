// ============================================
// Google Apps Script - 일일 체크리스트 & 캘린더 API
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
const TEMPLATE_SHEET = '템플릿';

/**
 * 초기 시트 구조 세팅 (최초 1회 실행)
 */
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 체크리스트 시트
  let clSheet = ss.getSheetByName(CHECKLIST_SHEET);
  if (!clSheet) {
    clSheet = ss.insertSheet(CHECKLIST_SHEET);
    clSheet.getRange('A1:F1').setValues([['날짜', '항목명', '완료여부', '타입', '순서', 'ID']]);
    clSheet.getRange('A1:F1').setFontWeight('bold');
    clSheet.setFrozenRows(1);
  }

  // 템플릿 시트
  let tmplSheet = ss.getSheetByName(TEMPLATE_SHEET);
  if (!tmplSheet) {
    tmplSheet = ss.insertSheet(TEMPLATE_SHEET);
    tmplSheet.getRange('A1:C1').setValues([['항목명', '순서', 'ID']]);
    tmplSheet.getRange('A1:C1').setFontWeight('bold');
    tmplSheet.setFrozenRows(1);

    // 기본 템플릿 항목 예시
    const defaults = [
      ['물 2L 마시기', 1, generateId()],
      ['운동 30분', 2, generateId()],
      ['독서 20분', 3, generateId()],
      ['일기 쓰기', 4, generateId()],
    ];
    tmplSheet.getRange(2, 1, defaults.length, 3).setValues(defaults);
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
      case 'getCalendar':
        result = getCalendar(e.parameter.date);
        break;
      case 'getTemplates':
        result = getTemplates();
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
      case 'saveTemplates':
        result = saveTemplates(data.templates);
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
 * 해당 날짜 데이터가 없으면 템플릿에서 자동 생성
 */
function getChecklist(dateStr) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CHECKLIST_SHEET);

  if (!sheet || sheet.getLastRow() < 2) {
    // 데이터가 없으면 템플릿에서 생성
    return createFromTemplate(dateStr);
  }

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues();
  const items = data
    .filter(row => {
      const rowDate = Utilities.formatDate(new Date(row[0]), Session.getScriptTimeZone(), 'yyyy-MM-dd');
      return rowDate === dateStr;
    })
    .map(row => ({
      name: row[1],
      done: row[2] === true || row[2] === 'TRUE' || row[2] === true,
      type: row[3],
      order: row[4],
      id: row[5]
    }))
    .sort((a, b) => a.order - b.order);

  if (items.length === 0) {
    return createFromTemplate(dateStr);
  }

  return { date: dateStr, items: items };
}

/**
 * 템플릿에서 오늘의 체크리스트 자동 생성
 */
function createFromTemplate(dateStr) {
  const templates = getTemplates().templates;
  const items = templates.map(t => ({
    name: t.name,
    done: false,
    type: '고정',
    order: t.order,
    id: generateId()
  }));

  // 시트에 저장
  if (items.length > 0) {
    saveChecklist(dateStr, items);
  }

  return { date: dateStr, items: items };
}

/**
 * 체크리스트 저장 (해당 날짜 전체 덮어쓰기)
 */
function saveChecklist(dateStr, items) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CHECKLIST_SHEET);

  if (!sheet) {
    return { error: 'Sheet not found. Run setupSheets() first.' };
  }

  // 기존 해당 날짜 데이터 삭제
  if (sheet.getLastRow() >= 2) {
    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues();
    const rowsToDelete = [];

    for (let i = data.length - 1; i >= 0; i--) {
      const rowDate = Utilities.formatDate(new Date(data[i][0]), Session.getScriptTimeZone(), 'yyyy-MM-dd');
      if (rowDate === dateStr) {
        rowsToDelete.push(i + 2); // 1-indexed + header
      }
    }

    // 뒤에서부터 삭제 (인덱스 밀림 방지)
    for (const row of rowsToDelete) {
      sheet.deleteRow(row);
    }
  }

  // 새 데이터 추가
  if (items.length > 0) {
    const newRows = items.map((item, idx) => [
      dateStr,
      item.name,
      item.done || false,
      item.type || '추가',
      item.order !== undefined ? item.order : idx + 1,
      item.id || generateId()
    ]);

    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, 6).setValues(newRows);
  }

  return { success: true, date: dateStr, count: items.length };
}

/**
 * 템플릿 목록 가져오기
 */
function getTemplates() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TEMPLATE_SHEET);

  if (!sheet || sheet.getLastRow() < 2) {
    return { templates: [] };
  }

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  const templates = data
    .filter(row => row[0] !== '')
    .map(row => ({
      name: row[0],
      order: row[1],
      id: row[2]
    }))
    .sort((a, b) => a.order - b.order);

  return { templates: templates };
}

/**
 * 템플릿 저장 (전체 덮어쓰기)
 */
function saveTemplates(templates) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TEMPLATE_SHEET);

  if (!sheet) {
    return { error: 'Template sheet not found. Run setupSheets() first.' };
  }

  // 기존 데이터 삭제
  if (sheet.getLastRow() >= 2) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).clearContent();
  }

  // 새 데이터 추가
  if (templates.length > 0) {
    const newRows = templates.map((t, idx) => [
      t.name,
      t.order !== undefined ? t.order : idx + 1,
      t.id || generateId()
    ]);
    sheet.getRange(2, 1, newRows.length, 3).setValues(newRows);
  }

  return { success: true, count: templates.length };
}

/**
 * 구글 캘린더 일정 가져오기
 */
function getCalendar(dateStr) {
  const date = new Date(dateStr);
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0);
  const endOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59);

  const calendar = CalendarApp.getDefaultCalendar();
  const events = calendar.getEvents(startOfDay, endOfDay);

  const eventList = events.map(event => ({
    title: event.getTitle(),
    start: event.getStartTime().toISOString(),
    end: event.getEndTime().toISOString(),
    allDay: event.isAllDayEvent(),
    location: event.getLocation() || '',
    description: event.getDescription() || ''
  }));

  // 주간 일정도 함께 가져오기 (해당 주 월~일)
  const dayOfWeek = date.getDay();
  const monday = new Date(date);
  monday.setDate(date.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59);
  monday.setHours(0, 0, 0);

  const weekEvents = calendar.getEvents(monday, sunday);
  const weekData = {};

  weekEvents.forEach(event => {
    const eventDate = Utilities.formatDate(event.getStartTime(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    if (!weekData[eventDate]) {
      weekData[eventDate] = [];
    }
    weekData[eventDate].push({
      title: event.getTitle(),
      start: event.getStartTime().toISOString(),
      end: event.getEndTime().toISOString(),
      allDay: event.isAllDayEvent()
    });
  });

  return {
    date: dateStr,
    events: eventList,
    weekEvents: weekData
  };
}
