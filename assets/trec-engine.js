// Dossie TREC Deadline Engine — shared across /calculator and /guides/*
// Port of src/utils/trec-deadline-engine.js from the Dossie app repo.
// Pure functions. No deps. window.TRECEngine.compute(inputs) → { ok, deadlines, warnings }
(function () {
  'use strict';

  var FEDERAL_HOLIDAYS = [
    // 2026
    '2026-01-01','2026-01-19','2026-02-16','2026-05-25','2026-06-19',
    '2026-07-03','2026-09-07','2026-10-12','2026-11-11','2026-11-26','2026-12-25',
    // 2027
    '2027-01-01','2027-01-18','2027-02-15','2027-05-31','2027-06-18',
    '2027-07-05','2027-09-06','2027-10-11','2027-11-11','2027-11-25','2027-12-24',
    // 2028
    '2028-01-17','2028-02-21','2028-05-29','2028-06-19','2028-07-04',
    '2028-09-04','2028-10-09','2028-11-10','2028-11-23','2028-12-25'
  ];
  var HOLIDAY_SET = new Set(FEDERAL_HOLIDAYS);

  function parseISODate(iso) {
    if (!iso || typeof iso !== 'string') return null;
    var m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }
  function formatISODate(d) {
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }
  function isWeekend(d) { var x = d.getDay(); return x === 0 || x === 6; }
  function isHoliday(d) { return HOLIDAY_SET.has(formatISODate(d)); }
  function isRolloverDay(d) { return isWeekend(d) || isHoliday(d); }

  function addDays(d, n) {
    var r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
  }
  function addDaysWithRollover(start, days) {
    var end = addDays(start, days);
    var rolled = new Date(end);
    var reasons = [];
    while (isRolloverDay(rolled)) {
      if (isWeekend(rolled)) {
        reasons.push(formatISODate(rolled) + ' is a ' + (rolled.getDay() === 0 ? 'Sunday' : 'Saturday'));
      } else {
        reasons.push(formatISODate(rolled) + ' is a federal holiday');
      }
      rolled = addDays(rolled, 1);
    }
    var didRoll = formatISODate(end) !== formatISODate(rolled);
    return {
      date: rolled,
      rolled: didRoll,
      reason: didRoll ? reasons.join('; ') + ' — rolled to ' + formatISODate(rolled) : null
    };
  }
  function daysBetween(from, to) {
    var MS = 86400000;
    var f = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    var t = new Date(to.getFullYear(), to.getMonth(), to.getDate());
    return Math.round((t - f) / MS);
  }
  function setDeadlineHour(d, h) {
    var r = new Date(d);
    r.setHours(h || 17, 0, 0, 0);
    return r;
  }
  function formatDisplay(d) {
    var DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var hour = d.getHours();
    var ampm = hour >= 12 ? 'PM' : 'AM';
    hour = hour % 12 || 12;
    return DAYS[d.getDay()] + ', ' + MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear() + ' · ' + hour + ':00 ' + ampm;
  }
  function tone(daysRemaining) {
    if (daysRemaining < 0) return 'overdue';
    if (daysRemaining === 0) return 'due-today';
    if (daysRemaining <= 2) return 'urgent';
    if (daysRemaining <= 7) return 'upcoming';
    return 'far';
  }
  function pillLabel(daysRemaining) {
    if (daysRemaining < 0) return Math.abs(daysRemaining) + (Math.abs(daysRemaining) === 1 ? ' day overdue' : ' days overdue');
    if (daysRemaining === 0) return 'Due today';
    if (daysRemaining === 1) return 'Tomorrow';
    return 'In ' + daysRemaining + ' days';
  }

  function build(label, icon, paragraph, deadlineDate, today, extras) {
    extras = extras || {};
    var dr = daysBetween(today, deadlineDate);
    return {
      id: extras.id || label.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      label: label,
      icon: icon,
      paragraph: paragraph,
      date: deadlineDate.toISOString(),
      dateDisplay: formatDisplay(deadlineDate),
      daysRemaining: dr,
      tone: tone(dr),
      pillLabel: pillLabel(dr),
      rolledOver: !!extras.rolled,
      rolloverReason: extras.reason || null,
      warnings: extras.warnings || []
    };
  }

  function compute(inputs) {
    var effective = parseISODate(inputs.effectiveDate);
    var closing = parseISODate(inputs.closingDate);
    if (!effective || !closing) return { ok: false, errors: ['effective date and closing date are required'] };

    var today = new Date();
    today.setHours(0, 0, 0, 0);

    var deadlines = [];

    if (inputs.earnestDays > 0) {
      var em = addDaysWithRollover(effective, inputs.earnestDays);
      deadlines.push(build('Earnest Money Due', '💵', '¶ 5A', setDeadlineHour(em.date, 17), today, {
        id: 'earnest-money', rolled: em.rolled, reason: em.reason
      }));
    }

    if (inputs.optionFeeDays > 0) {
      var of = addDaysWithRollover(effective, inputs.optionFeeDays);
      deadlines.push(build('Option Fee Due', '🧾', '¶ 5A', setDeadlineHour(of.date, 17), today, {
        id: 'option-fee', rolled: of.rolled, reason: of.reason
      }));
    }

    if (inputs.optionDays > 0) {
      var opEnd = addDays(effective, inputs.optionDays);
      var warn = [];
      if (isWeekend(opEnd)) warn.push('Option period ends on a weekend. Per ¶ 5B, the option period does NOT roll — notice must still be delivered by 5:00 PM on this date.');
      if (isHoliday(opEnd)) warn.push('Option period ends on a federal holiday. Per ¶ 5B, the option period does NOT roll.');
      deadlines.push(build('Option Period Expires', '🔔', '¶ 5B', setDeadlineHour(opEnd, 17), today, {
        id: 'option-period-expiry', warnings: warn
      }));
    }

    if (inputs.surveyDays > 0) {
      var sv = addDaysWithRollover(effective, inputs.surveyDays);
      deadlines.push(build('Survey Deadline', '📐', '¶ 6C', setDeadlineHour(sv.date, 17), today, {
        id: 'survey', rolled: sv.rolled, reason: sv.reason
      }));
    }

    if (inputs.financingDays > 0) {
      var fn = addDaysWithRollover(effective, inputs.financingDays);
      deadlines.push(build('Financing Deadline', '🏦', 'TPFA 40-11', setDeadlineHour(fn.date, 17), today, {
        id: 'financing', rolled: fn.rolled, reason: fn.reason
      }));
    }

    deadlines.push(build('Closing Date', '🏡', '¶ 9A', setDeadlineHour(closing, 17), today, {
      id: 'closing'
    }));

    deadlines.sort(function (a, b) { return new Date(a.date) - new Date(b.date); });

    var globalWarnings = [];
    var financingD = deadlines.find(function (d) { return d.id === 'financing'; });
    var closingD = deadlines.find(function (d) { return d.id === 'closing'; });
    if (financingD && closingD && new Date(financingD.date) >= new Date(closingD.date)) {
      globalWarnings.push('Financing deadline is on or after closing — the buyer must have loan approval before closing.');
    }
    var optionD = deadlines.find(function (d) { return d.id === 'option-period-expiry'; });
    if (optionD && closingD && new Date(optionD.date) >= new Date(closingD.date)) {
      globalWarnings.push('Option period ends on or after closing — verify dates.');
    }

    return { ok: true, deadlines: deadlines, warnings: globalWarnings };
  }

  window.TRECEngine = { compute: compute };
})();
