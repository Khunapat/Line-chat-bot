/**
 * The 36-day speaking plan. Lesson days follow the 30 lessons of
 * HSK Standard Course 1 and 2 (HSK标准教程, Beijing Language and Culture
 * University Press) in order, five lessons a week, and every sixth day is a
 * review with no new words. Target words come from the official HSK level 1-2
 * word lists (test/plan.test.js checks each one against lib/hsk-words.js).
 */

const WEEKS = [
  'HSK 1 · Meeting people',
  'HSK 1 · Everyday needs',
  'HSK 1 · Time and activities',
  'HSK 2 · Routines and things',
  'HSK 2 · Food, travel and study',
  'HSK 2 · Compare and describe',
];

const w = (hanzi, pinyin, meaning) => ({ hanzi, pinyin, meaning });

// Lesson rows: [book, lesson, Chinese title, topic, words, pattern, scene].
// Review rows: ['review', scene].
const ROWS = [
  [1, 1, '你好', 'Hello', [
    w('你', 'nǐ', 'you'), w('好', 'hǎo', 'good'), w('您', 'nín', 'you (polite)'),
    w('对不起', 'duìbuqǐ', 'sorry'), w('没关系', 'méi guānxi', "it's OK")],
  '你好 / 您好', 'Bump into a stranger in a lift and apologize'],
  [1, 2, '谢谢你', 'Thank you', [
    w('谢谢', 'xièxie', 'thank you'), w('不', 'bù', 'not'), w('不客气', 'bù kèqi', "you're welcome"),
    w('再见', 'zàijiàn', 'goodbye')],
  '不 + verb', 'A neighbor helps carry your bags up the stairs'],
  [1, 3, '你叫什么名字', "What's your name", [
    w('叫', 'jiào', 'to be called'), w('什么', 'shénme', 'what'), w('名字', 'míngzi', 'name'),
    w('是', 'shì', 'to be'), w('学生', 'xuésheng', 'student'), w('中国', 'Zhōngguó', 'China')],
  '…吗？ (yes/no questions)', 'First day at a language exchange'],
  [1, 4, '她是我的汉语老师', 'She is my Chinese teacher', [
    w('谁', 'shéi', 'who'), w('的', 'de', "of, 's"), w('汉语', 'Hànyǔ', 'Chinese language'),
    w('老师', 'lǎoshī', 'teacher'), w('同学', 'tóngxué', 'classmate'), w('朋友', 'péngyou', 'friend'),
    w('哪', 'nǎ', 'which')],
  'A 的 B / 哪国人？', 'Introduce the people in a photo on your phone'],
  [1, 5, '她女儿今年二十岁', 'Her daughter is 20 this year', [
    w('家', 'jiā', 'home, family'), w('有', 'yǒu', 'to have'), w('几', 'jǐ', 'how many'),
    w('岁', 'suì', 'years old'), w('女儿', "nǚ'ér", 'daughter'), w('今年', 'jīnnián', 'this year')],
  '几 + measure word / 多大？', 'Chat about your family over coffee'],
  ['review', 'Party: meet 3 new people and introduce yourself'],

  [1, 6, '我会说汉语', 'I can speak Chinese', [
    w('会', 'huì', 'can (learned skill)'), w('说', 'shuō', 'to speak'), w('做', 'zuò', 'to do, to make'),
    w('菜', 'cài', 'dish, food'), w('写', 'xiě', 'to write'), w('字', 'zì', 'character'),
    w('怎么', 'zěnme', 'how')],
  '会 + verb', "Tell a new friend what you can and can't do"],
  [1, 7, '今天几号', "What's the date today", [
    w('今天', 'jīntiān', 'today'), w('明天', 'míngtiān', 'tomorrow'), w('昨天', 'zuótiān', 'yesterday'),
    w('月', 'yuè', 'month'), w('号', 'hào', 'day of the month'), w('星期', 'xīngqī', 'week'),
    w('去', 'qù', 'to go')],
  '几月几号？ / 星期几？', 'Plan a meeting with a coworker'],
  [1, 8, '我想喝茶', "I'd like some tea", [
    w('想', 'xiǎng', 'would like'), w('喝', 'hē', 'to drink'), w('茶', 'chá', 'tea'),
    w('米饭', 'mǐfàn', 'cooked rice'), w('买', 'mǎi', 'to buy'), w('多少', 'duōshao', 'how much'),
    w('钱', 'qián', 'money'), w('块', 'kuài', 'yuan (spoken)')],
  '多少钱？', 'Order drinks at a café and pay'],
  [1, 9, '你儿子在哪儿工作', 'Where does your son work', [
    w('在', 'zài', 'at, in'), w('哪儿', 'nǎr', 'where'), w('工作', 'gōngzuò', 'to work, job'),
    w('医院', 'yīyuàn', 'hospital'), w('医生', 'yīshēng', 'doctor'), w('儿子', 'érzi', 'son'),
    w('爸爸', 'bàba', 'dad')],
  '在 + place + verb', 'Ask a taxi driver about their family and work'],
  [1, 10, '我能坐这儿吗', 'Can I sit here', [
    w('能', 'néng', 'can, may'), w('坐', 'zuò', 'to sit'), w('这儿', 'zhèr', 'here'),
    w('请', 'qǐng', 'please'), w('桌子', 'zhuōzi', 'table'), w('椅子', 'yǐzi', 'chair'),
    w('前面', 'qiánmiàn', 'in front')],
  '能…吗？ / place + 有 + thing', 'Find a seat in a busy restaurant'],
  ['review', 'Birthday dinner: dates, food, family and seats'],

  [1, 11, '现在几点', 'What time is it now', [
    w('现在', 'xiànzài', 'now'), w('点', 'diǎn', "o'clock"), w('分', 'fēn', 'minute'),
    w('中午', 'zhōngwǔ', 'noon'), w('时候', 'shíhou', 'time, when'), w('回', 'huí', 'to return'),
    w('电影', 'diànyǐng', 'movie')],
  '什么时候？ / time + verb', 'Agree on a time to see a movie'],
  [1, 12, '明天天气怎么样', "What's the weather like tomorrow", [
    w('天气', 'tiānqì', 'weather'), w('怎么样', 'zěnmeyàng', 'how is it'), w('太', 'tài', 'too'),
    w('热', 'rè', 'hot'), w('冷', 'lěng', 'cold'), w('下雨', 'xiàyǔ', 'to rain')],
  '太…了', 'Plan the weekend around the weather'],
  [1, 13, '他在学做中国菜呢', 'He is learning to cook Chinese food', [
    w('喂', 'wèi', 'hello (on the phone)'), w('学习', 'xuéxí', 'to study'), w('睡觉', 'shuìjiào', 'to sleep'),
    w('电视', 'diànshì', 'TV'), w('喜欢', 'xǐhuan', 'to like'), w('打电话', 'dǎ diànhuà', 'to phone'),
    w('上午', 'shàngwǔ', 'morning')],
  '在 + verb + 呢', 'Phone call: "What are you doing right now?"'],
  [1, 14, '她买了不少衣服', 'She bought quite a lot of clothes', [
    w('东西', 'dōngxi', 'things'), w('衣服', 'yīfu', 'clothes'), w('漂亮', 'piàoliang', 'pretty'),
    w('少', 'shǎo', 'few, little'), w('都', 'dōu', 'all'), w('看见', 'kànjiàn', 'to see'),
    w('苹果', 'píngguǒ', 'apple')],
  'verb + 了', 'Tell a friend what you bought at the mall'],
  [1, 15, '我是坐飞机来的', 'I came here by plane', [
    w('认识', 'rènshi', 'to know (someone)'), w('高兴', 'gāoxìng', 'glad'), w('飞机', 'fēijī', 'plane'),
    w('出租车', 'chūzūchē', 'taxi'), w('来', 'lái', 'to come'), w('饭馆', 'fànguǎn', 'restaurant'),
    w('北京', 'Běijīng', 'Beijing')],
  '是…的', 'Tell someone how and when you got here'],
  ['review', 'A full day in a new city: time, weather, shopping, getting around'],

  [2, 1, '九月去北京旅游最好', 'September is the best time to visit Beijing', [
    w('旅游', 'lǚyóu', 'to travel'), w('最', 'zuì', 'most'), w('觉得', 'juéde', 'to think, to feel'),
    w('为什么', 'wèishénme', 'why'), w('也', 'yě', 'also'), w('一起', 'yīqǐ', 'together'),
    w('要', 'yào', 'to want, going to')],
  '最 + adjective / 觉得…', 'Plan a trip with a friend: when and where to go'],
  [2, 2, '我每天六点起床', 'I get up at six every day', [
    w('起床', 'qǐchuáng', 'to get up'), w('每', 'měi', 'every'), w('早上', 'zǎoshang', 'early morning'),
    w('跑步', 'pǎobù', 'to run'), w('生病', 'shēngbìng', 'to get sick'), w('身体', 'shēntǐ', 'body, health'),
    w('药', 'yào', 'medicine')],
  '每天… / 多 + adjective', 'Tell a doctor about your daily routine and your stair workout'],
  [2, 3, '左边那个红色的是我的', 'The red one on the left is mine', [
    w('左边', 'zuǒbian', 'left side'), w('右边', 'yòubian', 'right side'), w('红', 'hóng', 'red'),
    w('颜色', 'yánsè', 'color'), w('旁边', 'pángbiān', 'beside'), w('手表', 'shǒubiǎo', 'watch'),
    w('送', 'sòng', 'to give (a gift)'), w('真', 'zhēn', 'really')],
  'adjective + 的 ("the … one")', 'Find your bag and coat at a party'],
  [2, 4, '这个工作是他帮我介绍的', 'He recommended me for this job', [
    w('介绍', 'jièshào', 'to introduce'), w('公司', 'gōngsī', 'company'), w('上班', 'shàngbān', 'to go to work'),
    w('知道', 'zhīdào', 'to know'), w('已经', 'yǐjīng', 'already'), w('生日', 'shēngrì', 'birthday'),
    w('快乐', 'kuàilè', 'happy')],
  '是…的 (who, when, how)', 'Tell a coworker how you got your job'],
  [2, 5, '就买这件吧', "Let's just buy this one", [
    w('件', 'jiàn', 'measure word for clothes'), w('就', 'jiù', 'just, then'), w('吧', 'ba', '(suggestion)'),
    w('便宜', 'piányi', 'cheap'), w('贵', 'guì', 'expensive'), w('可以', 'kěyǐ', 'can, may'),
    w('还', 'hái', 'still, also')],
  '有点儿 + adjective', 'Buy a jacket at a market and bargain'],
  ['review', 'Weekend trip: plan it, pack, shop and meet a new coworker'],

  [2, 6, '你怎么不吃了', "Why aren't you eating anymore", [
    w('因为', 'yīnwèi', 'because'), w('所以', 'suǒyǐ', 'so'), w('好吃', 'hǎochī', 'tasty'),
    w('羊肉', 'yángròu', 'lamb'), w('鱼', 'yú', 'fish'), w('鸡蛋', 'jīdàn', 'egg'),
    w('西瓜', 'xīguā', 'watermelon')],
  '因为…所以… / 怎么不…了？', "Dinner at a friend's home: talk about the food"],
  [2, 7, '你家离公司远吗', 'Is your home far from your company', [
    w('离', 'lí', 'from (distance)'), w('远', 'yuǎn', 'far'), w('近', 'jìn', 'near'),
    w('公共汽车', 'gōnggòng qìchē', 'bus'), w('小时', 'xiǎoshí', 'hour'), w('自行车', 'zìxíngchē', 'bicycle'),
    w('走', 'zǒu', 'to walk')],
  'A 离 B 远 / 近', 'Compare your commutes with a coworker'],
  [2, 8, '让我想想再告诉你', "Let me think about it and I'll tell you", [
    w('让', 'ràng', 'to let'), w('告诉', 'gàosu', 'to tell'), w('再', 'zài', 'again, then'),
    w('事情', 'shìqing', 'matter, thing'), w('找', 'zhǎo', 'to look for'), w('唱歌', 'chànggē', 'to sing'),
    w('跳舞', 'tiàowǔ', 'to dance')],
  'verb + verb (想想) / 再', 'A friend invites you out and you need time to decide'],
  [2, 9, '题太多，我没做完', "Too many questions, I didn't finish", [
    w('题', 'tí', 'question (on a test)'), w('完', 'wán', 'to finish'), w('错', 'cuò', 'wrong'),
    w('懂', 'dǒng', 'to understand'), w('考试', 'kǎoshì', 'exam'), w('意思', 'yìsi', 'meaning'),
    w('问题', 'wèntí', 'question, problem')],
  'verb + 完 / 懂 / 错 (result)', 'Talk with a classmate after a hard exam'],
  [2, 10, '别找了，手机在桌子上呢', 'Stop looking, your phone is on the desk', [
    w('别', 'bié', "don't"), w('手机', 'shǒujī', 'mobile phone'), w('洗', 'xǐ', 'to wash'),
    w('到', 'dào', 'to arrive'), w('机场', 'jīchǎng', 'airport'), w('教室', 'jiàoshì', 'classroom'),
    w('正在', 'zhèngzài', 'in the middle of')],
  '别 + verb + 了', "Rushing to the airport and you can't find your things"],
  ['review', 'A busy week: food, commute, exams and a lost phone'],

  [2, 11, '他比我大三岁', 'He is three years older than me', [
    w('比', 'bǐ', 'than'), w('哥哥', 'gēge', 'older brother'), w('姐姐', 'jiějie', 'older sister'),
    w('弟弟', 'dìdi', 'younger brother'), w('妹妹', 'mèimei', 'younger sister'), w('高', 'gāo', 'tall'),
    w('可能', 'kěnéng', 'maybe')],
  'A 比 B + adjective (+ amount)', 'Compare yourself with your brothers, sisters or friends'],
  [2, 12, '你穿得太少了', "You're wearing too little", [
    w('穿', 'chuān', 'to wear'), w('得', 'de', '(links verb and result)'), w('雪', 'xuě', 'snow'),
    w('晴', 'qíng', 'sunny'), w('阴', 'yīn', 'cloudy'), w('累', 'lèi', 'tired'), w('忙', 'máng', 'busy')],
  'verb + 得 + adjective', "A cold morning: a friend says you're not dressed warmly enough"],
  [2, 13, '门开着呢', 'The door is open', [
    w('门', 'mén', 'door'), w('着', 'zhe', '(ongoing state)'), w('开', 'kāi', 'to open'),
    w('笑', 'xiào', 'to smile, to laugh'), w('从', 'cóng', 'from'), w('外', 'wài', 'outside'),
    w('房间', 'fángjiān', 'room')],
  'verb + 着', 'Describe a room and the people in it'],
  [2, 14, '你看过那个电影吗', 'Have you seen that movie', [
    w('过', 'guo', '(have done before)'), w('次', 'cì', 'time(s)'), w('第一', 'dìyī', 'first'),
    w('玩', 'wán', 'to play, to have fun'), w('游泳', 'yóuyǒng', 'to swim'), w('打篮球', 'dǎ lánqiú', 'to play basketball'),
    w('时间', 'shíjiān', 'time')],
  'verb + 过', '"Have you ever…?": swap experiences'],
  [2, 15, '新年就要到了', 'The New Year is coming soon', [
    w('新', 'xīn', 'new'), w('希望', 'xīwàng', 'to hope'), w('大家', 'dàjiā', 'everyone'),
    w('欢迎', 'huānyíng', 'to welcome'), w('去年', 'qùnián', 'last year'), w('准备', 'zhǔnbèi', 'to prepare')],
  '就要…了 / 快…了', 'Plan a New Year party with friends'],
  ['review', 'Tell a 2-minute story about your whole plan, then take questions'],
];

export const TOTAL_DAYS = ROWS.length;
export const REVIEW_DAYS = ROWS.flatMap((row, i) => (row[0] === 'review' ? [i + 1] : []));

export const PLAN = Object.freeze(ROWS.map((row, i) => {
  const day = i + 1;
  const week = Math.ceil(day / 6);
  const base = { day, week, weekTitle: WEEKS[week - 1] };
  if (row[0] === 'review') {
    // Each review covers its week's five lessons; the last one covers every lesson.
    const last = day === TOTAL_DAYS;
    const reviewOf = [];
    for (let d = last ? 1 : day - 5; d < day; d++) if (!REVIEW_DAYS.includes(d)) reviewOf.push(d);
    return Object.freeze({
      ...base,
      topic: last ? 'Final review' : `Review of days ${day - 5}-${day - 1}`,
      words: [],
      glossary: [],
      scene: row[1],
      review: true,
      reviewOf,
    });
  }
  const [book, lesson, title, topic, glossary, pattern, scene] = row;
  return Object.freeze({
    ...base,
    topic,
    title,
    source: `HSK Standard Course ${book}, lesson ${lesson}`,
    words: glossary.map((g) => g.hanzi),
    glossary,
    pattern,
    scene,
    review: false,
  });
}));

/** The plan entry for day `n` (1..TOTAL_DAYS), or null. */
export function getDay(n) {
  return Number.isInteger(n) && n >= 1 && n <= PLAN.length ? PLAN[n - 1] : null;
}
