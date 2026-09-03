import { parseLineRosterMessage } from './parser';

const example1 = `@All 
แบดวินนิ่ง อังคาร 8/9/26
19.00-20.00  1 คอร์ท
20.00-22.00  3 คอร์ท 10+11+12
1. ตั้ม
2. เบส
3. 
4. 
5. 
6. 
7.  
8. 
9. 
10. 
11. 
12. 
13. 
14. 
15. 
16. 
17. 
18.
19.
20.
สำรอง
1.
2.
3.`;

const example2 = `วัน "พฤ" 3/8/69 , 2 คอร์ด เวลา 20.00 - 22.00 @ KIP
1. ซัน
2. มุกกี้
3. อั๋น
4. ไอซ์
5. ไบรท์
6. บูม
7. เกม
8.เกีย
9. ไกด์
10. ปอม
11. พี่แวน(พี่ที่ทำงานไกด์)`;

const example3 = `@All ตีแบดสนามมาม่าแบดมินตัน
## วันอาทิตย์ 06/09/2026 14.00-16.00
(จองแล้ว 1คอร์ด )
1. ปอม
2. ไม้
3. เกียร์
4. ตูน
5. ตี๋
6. 
7. 
8. 
9. 
10. 
11. 
12. 
13. 
14 
15 
16
17
18
19
20
สำรอง
1.
2.
3.
4.
หมายเหตุ เนื่องจากสนามนี้มีเงื่อนไขในการยกเลิกที่ลำบากต่อการจองเยอะๆแล้วมายกเลิกภายหลัง จึงขอจองก่อน 1 คอร์ด หากคนลงชื่อถึง รายชื่อสำรองหรือถึง8คน จะทำการจอง 2คอร์ดครับ ขอความกรุณาลงชื่อภายในวันพฤหัสหรือเร็วกว่านั้นเพื่อเป็นการยืนยันว่าจะมีคอร์ดเหลือ เพื่อลดปัญหารอเล่นนานครับ

หมายเหตุ 2 ห้ามลงชื่อเพิ่มวันอาทิตย์เช้า`;

function report(label: string, text: string) {
  console.log(`\n===== ${label} =====`);
  const result = parseLineRosterMessage(text);
  console.log('--- header ---');
  console.log(result.header);
  console.log('--- roster (filled only) ---');
  console.log(result.roster.filter((s) => s.name));
  console.log(`roster total slots: ${result.roster.length}, filled: ${result.roster.filter((s) => s.name).length}`);
  console.log('--- waitlist (filled only) ---');
  console.log(result.waitlist.filter((s) => s.name));
  console.log(`waitlist total slots: ${result.waitlist.length}`);
  console.log('--- unrecognized lines ---');
  console.log(result.unrecognizedLines);
  console.log('--- warnings ---');
  console.log(result.warnings);
}

report('Example 1 (แบดวินนิ่ง อังคาร)', example1);
report('Example 2 (KIP)', example2);
report('Example 3 (มาม่าแบดมินตัน)', example3);
