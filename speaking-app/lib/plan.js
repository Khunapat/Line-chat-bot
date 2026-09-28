/**
 * The 30-day speaking plan (days 1-15 follow HSK Standard Course 1,
 * days 16-30 everyday situations at about HSK 2). Review days have no new
 * words; they mix the scenes of the days listed in `reviewOf`.
 */

const WEEKS = [
  'Meeting people',
  'Numbers, time, wants',
  'Places and daily life',
  'Doing things',
  'Real situations',
  'Opinions and stories',
];

// [topic, words, scene]; review days use null words.
const ROWS = [
  ['Hello', ['你好', '您', '对不起', '没关系'], 'Bump into a stranger in a lift and apologize'],
  ['Thank you', ['谢谢', '不客气', '再见', '不 + verb'], 'A neighbor helps carry your bags'],
  ["What's your name", ['叫', '名字', '是', '哪国人', '吗'], 'First day at a language exchange'],
  ['She is my teacher', ['老师', '学生', '朋友', '的', '谁'], 'Introduce people in a photo'],
  ['Review', null, 'Party: meet 3 people'],
  ['Family and age', ['家', '几口人', '女儿', '儿子', '岁', '了'], 'Chat about your family over coffee'],
  ['I can speak Chinese', ['会', '说', '做', '写', '怎么', '字'], "Tell a new friend what you can and can't do"],
  ["What's the date", ['今天', '明天', '几号', '星期几', '月'], 'Plan a meeting with a coworker'],
  ["I'd like some tea", ['想', '喝', '吃', '茶', '米饭', '多少钱'], 'Order at a café'],
  ['Review', null, 'Birthday dinner planning'],
  ['Where do you work', ['在', '哪儿', '工作', '医院', '公司', '学校'], 'Ask a taxi driver about his job'],
  ['Can I sit here', ['能', '坐', '这儿', '请', '桌子', '椅子'], 'Busy restaurant, find a seat'],
  ['What time is it', ['现在', '点', '分', '起床', '睡觉', '时候'], 'Describe your daily routine'],
  ["Tomorrow's weather", ['天气', '怎么样', '冷', '热', '下雨', '太…了'], 'Plan the weekend around the weather'],
  ['Review', null, 'A full day in a new city'],
  ['Learning to cook', ['在 + verb + 呢', '做饭', '菜', '学习'], 'Phone call: "what are you doing?"'],
  ['Shopping for clothes', ['买', '衣服', '了', '不少', '贵', '便宜'], 'Buy a jacket and bargain at a market'],
  ['Travel and transport', ['是…的', '坐飞机', '开车', '出租车', '火车站'], 'Tell someone how you got here'],
  ['Directions', ['左边', '右边', '前面', '离…远/近', '走'], 'Ask the way to the subway station'],
  ['Review', null, 'Weekend trip: shopping, taxi, directions'],
  ['At the doctor', ['生病', '身体', '疼', '药', '休息', '觉得'], 'Tell a doctor your symptoms'],
  ['Hobbies and sport', ['喜欢', '运动', '跑步', '爬楼梯', '每天', '一…就…'], 'Talk about your stair workout'],
  ['Hotel check-in', ['房间', '住', '晚上', '可以…吗', '需要'], 'Check into a hotel, ask for a quiet room'],
  ['Comparing things', ['比', '更', '最', '一样'], 'Compare two phones or two cities'],
  ['Review', null, 'Get sick while traveling'],
  ['Past experience', ['过', '去过', '吃过', '第一次'], '"Have you ever been to…?"'],
  ['Plans and future', ['要', '打算', '准备', '以后', '希望'], 'Your plans for next year'],
  ['Work and study', ['忙', '公司', '开会', '因为…所以…'], 'Explain why you were late'],
  ['Giving opinions', ['我觉得', '为什么', '但是', '虽然…但是…'], 'Discuss: city life vs countryside'],
  ['Final review', null, 'Tell a 2-minute story about your month, then take questions'],
];

export const REVIEW_DAYS = [5, 10, 15, 20, 25, 30];

export const PLAN = Object.freeze(ROWS.map(([topic, words, scene], i) => {
  const day = i + 1;
  const week = Math.ceil(day / 5);
  const entry = { day, week, weekTitle: WEEKS[week - 1], topic, words: words || [], scene, review: !words };
  if (!words) {
    // Days 5-25 review the 4 days before; the final review covers every lesson day.
    const from = day === 30 ? 1 : day - 4;
    entry.reviewOf = [];
    for (let d = from; d < day; d++) if (!REVIEW_DAYS.includes(d)) entry.reviewOf.push(d);
    if (day !== 30) entry.topic = `Review of days ${from}-${day - 1}`;
  }
  return Object.freeze(entry);
}));

/** The plan entry for day `n` (1..30), or null. */
export function getDay(n) {
  return Number.isInteger(n) && n >= 1 && n <= PLAN.length ? PLAN[n - 1] : null;
}
