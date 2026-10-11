/**
 * mockData.ts — shared demo data for the Smart Restaurant POS Ecosystem.
 * Offline-first: emoji art only (no CDN — packaged app runs under
 * `default-src 'self'`), all numbers local.
 */
export type OrderStatus = 'new' | 'cooking' | 'ready' | 'completed' | 'cancelled';
export type OrderType = 'Dine-in' | 'Take Away' | 'Delivery';
export interface EcoOrderItem { readonly name: string; readonly qty: number; readonly price: number; }
export interface EcoOrder {
  readonly id: string; readonly num: number; readonly customer: string;
  readonly table: string; readonly type: OrderType; readonly status: OrderStatus;
  readonly items: readonly EcoOrderItem[]; readonly total: number; readonly timeAgo: string;
}
export type MenuCategory = 'Burgers'|'Sandwiches'|'Salads'|'Soups'|'Main Course'|'Beverages'|'Combos';
export interface EcoMenuItem {
  readonly id: string; readonly name: string; readonly emoji: string;
  readonly price: number; readonly oldPrice?: number; readonly category: MenuCategory;
  readonly veg: boolean; readonly kcal: number; readonly mins: number;
  readonly tag?: string; readonly grad: readonly [string, string];
}
export interface EcoStaff {
  readonly id: string; readonly name: string;
  readonly role: 'Cashier'|'Chef'|'Barista'; readonly level: number;
  readonly skillPct: number; readonly shift: string;
}
export const ECO_CATEGORIES: readonly (MenuCategory|'All')[] = ['All','Combos','Burgers','Sandwiches','Salads','Soups','Main Course','Beverages'];
export const ECO_MENU: readonly EcoMenuItem[] = [
  { id:'m01', name:'Veggie Burger', emoji:'🍔', price:9, category:'Burgers', veg:true, kcal:380, mins:10, tag:'BESTSELLER', grad:['#f6c177','#e8883a'] },
  { id:'m02', name:'Cheese Burger', emoji:'🍔', price:12, category:'Burgers', veg:false, kcal:520, mins:10, tag:'BESTSELLER', grad:['#f2b66d','#c8602b'] },
  { id:'m03', name:'Chicken Burger', emoji:'🍔', price:11, category:'Burgers', veg:false, kcal:480, mins:10, grad:['#f6c177','#c8602b'] },
  { id:'m04', name:'Special Sandwich', emoji:'🥪', price:14, category:'Sandwiches', veg:false, kcal:450, mins:8, grad:['#f3d9a4','#d49a4e'] },
  { id:'m05', name:'Club Sandwich', emoji:'🥪', price:13, category:'Sandwiches', veg:true, kcal:390, mins:7, grad:['#f3d9a4','#b97f35'] },
  { id:'m06', name:'Salad with Sesame', emoji:'🥗', price:16, category:'Salads', veg:true, kcal:210, mins:5, grad:['#b9e08a','#5aa845'] },
  { id:'m07', name:'Caesar Salad', emoji:'🥗', price:15, category:'Salads', veg:true, kcal:240, mins:5, grad:['#cdeaa0','#4e9a3d'] },
  { id:'m08', name:'Spicy Ramen', emoji:'🍜', price:15, category:'Soups', veg:false, kcal:520, mins:12, grad:['#ffb08a','#d6452b'] },
  { id:'m09', name:'Tom Yum Soup', emoji:'🍲', price:13, category:'Soups', veg:false, kcal:280, mins:10, grad:['#ffb08a','#b03a20'] },
  { id:'m10', name:'Pad Thai', emoji:'🍝', price:17, category:'Main Course', veg:false, kcal:560, mins:12, tag:'TRENDING +23%', grad:['#ffd0a0','#ff7a45'] },
  { id:'m11', name:'Green Curry Rice', emoji:'🍛', price:16, category:'Main Course', veg:false, kcal:540, mins:12, grad:['#b9e08a','#3d8a35'] },
  { id:'m12', name:'Fried Rice', emoji:'🍚', price:12, category:'Main Course', veg:true, kcal:470, mins:10, grad:['#f3d9a4','#c08a3a'] },
  { id:'m13', name:'Grilled Chicken', emoji:'🍗', price:18, category:'Main Course', veg:false, kcal:490, mins:15, grad:['#f2b66d','#a34a20'] },
  { id:'m14', name:'Lemonade', emoji:'🍋', price:4, category:'Beverages', veg:true, kcal:90, mins:2, grad:['#fff3a3','#e8c93a'] },
  { id:'m15', name:'Iced Coffee', emoji:'🧋', price:6, category:'Beverages', veg:true, kcal:120, mins:3, tag:'BESTSELLER', grad:['#d9b99a','#8a5a3c'] },
  { id:'m16', name:'Thai Tea', emoji:'🧃', price:5, category:'Beverages', veg:true, kcal:140, mins:2, grad:['#ffd0a0','#d4691e'] },
  { id:'m17', name:'Burger + Lemonade', emoji:'🍱', price:10, oldPrice:13, category:'Combos', veg:false, kcal:470, mins:10, tag:'-25%', grad:['#ffd0a0','#ff7a45'] },
  { id:'m18', name:'Ramen + Thai Tea', emoji:'🍱', price:17, oldPrice:20, category:'Combos', veg:false, kcal:660, mins:12, tag:'-15%', grad:['#ffb08a','#ff7a45'] },
];
export const ECO_INITIAL_ORDERS: readonly EcoOrder[] = [
  { id:'o1044', num:1044, customer:'William Defoe', table:'โต๊ะ 3', type:'Dine-in', status:'new', items:[{name:'Veggie Burger',qty:2,price:9}], total:18, timeAgo:'2 min ago' },
  { id:'o1043', num:1043, customer:'Nisreen A.', table:'โต๊ะ 5', type:'Dine-in', status:'cooking', items:[{name:'Pad Thai',qty:2,price:17},{name:'Thai Tea',qty:1,price:5}], total:39, timeAgo:'8 min ago' },
  { id:'o1042', num:1042, customer:'Kai Chen', table:'กลับบ้าน', type:'Take Away', status:'ready', items:[{name:'Spicy Ramen',qty:1,price:15},{name:'Lemonade',qty:2,price:4}], total:23, timeAgo:'12 min ago' },
  { id:'o1041', num:1041, customer:'Sara M.', table:'เดลิเวอรี', type:'Delivery', status:'cooking', items:[{name:'Burger + Lemonade',qty:1,price:10}], total:10, timeAgo:'15 min ago' },
  { id:'o1040', num:1040, customer:'John P.', table:'โต๊ะ 1', type:'Dine-in', status:'completed', items:[{name:'Green Curry Rice',qty:1,price:16}], total:16, timeAgo:'25 min ago' },
  { id:'o1039', num:1039, customer:'Aisha K.', table:'โต๊ะ 7', type:'Dine-in', status:'completed', items:[{name:'Caesar Salad',qty:1,price:15},{name:'Iced Coffee',qty:1,price:6}], total:21, timeAgo:'32 min ago' },
  { id:'o1038', num:1038, customer:'Tom B.', table:'กลับบ้าน', type:'Take Away', status:'completed', items:[{name:'Cheese Burger',qty:2,price:12}], total:24, timeAgo:'41 min ago' },
  { id:'o1037', num:1037, customer:'Lena S.', table:'โต๊ะ 2', type:'Dine-in', status:'ready', items:[{name:'Tom Yum Soup',qty:1,price:13}], total:13, timeAgo:'44 min ago' },
  { id:'o1036', num:1036, customer:'Omar F.', table:'เดลิเวอรี', type:'Delivery', status:'cancelled', items:[{name:'Fried Rice',qty:1,price:12}], total:12, timeAgo:'1 hr ago' },
  { id:'o1035', num:1035, customer:'Mia W.', table:'โต๊ะ 4', type:'Dine-in', status:'completed', items:[{name:'Club Sandwich',qty:1,price:13},{name:'Thai Tea',qty:2,price:5}], total:23, timeAgo:'1 hr ago' },
  { id:'o1034', num:1034, customer:'Ken T.', table:'โต๊ะ 6', type:'Dine-in', status:'completed', items:[{name:'Grilled Chicken',qty:1,price:18}], total:18, timeAgo:'2 hr ago' },
  { id:'o1033', num:1033, customer:'Priya R.', table:'กลับบ้าน', type:'Take Away', status:'completed', items:[{name:'Ramen + Thai Tea',qty:1,price:17}], total:17, timeAgo:'2 hr ago' },
];
export const ECO_STAFF: readonly EcoStaff[] = [
  { id:'s1', name:'Kai Chen', role:'Barista', level:3, skillPct:72, shift:'08:00 – 16:00' },
  { id:'s2', name:'William Defoe', role:'Cashier', level:4, skillPct:88, shift:'09:00 – 17:00' },
  { id:'s3', name:'Sara M.', role:'Chef', level:5, skillPct:95, shift:'08:00 – 16:00' },
  { id:'s4', name:'John P.', role:'Chef', level:2, skillPct:45, shift:'12:00 – 20:00' },
  { id:'s5', name:'Aisha K.', role:'Barista', level:2, skillPct:58, shift:'12:00 – 20:00' },
  { id:'s6', name:'Tom B.', role:'Cashier', level:1, skillPct:30, shift:'16:00 – 22:00' },
];
export const ECO_MONTHLY: readonly { readonly m: string; readonly revenue: number; readonly expense: number }[] = [
  { m:'Jan', revenue:182, expense:131 }, { m:'Feb', revenue:196, expense:138 },
  { m:'Mar', revenue:210, expense:145 }, { m:'Apr', revenue:188, expense:140 },
  { m:'May', revenue:224, expense:152 }, { m:'Jun', revenue:238, expense:158 },
  { m:'Jul', revenue:251, expense:164 }, { m:'Aug', revenue:246, expense:166 },
  { m:'Sep', revenue:262, expense:171 }, { m:'Oct', revenue:271, expense:176 },
  { m:'Nov', revenue:284, expense:182 }, { m:'Dec', revenue:296, expense:190 },
];
export const ECO_BRANCHES: readonly { readonly name: string; readonly revenue: string; readonly orders: number; readonly score: number; readonly rank: number }[] = [
  { name:'Siam', revenue:'฿1.21M', orders:1984, score:94, rank:1 },
  { name:'On Nut', revenue:'฿0.93M', orders:1622, score:87, rank:2 },
  { name:'Ekkamai', revenue:'฿0.70M', orders:1215, score:76, rank:3 },
];
export const ECO_ACTIVITY: readonly { readonly t: string; readonly text: string }[] = [
  { t:'10:42', text:'New order #1044 placed (Dine-in, โต๊ะ 3)' },
  { t:'10:35', text:'Staff Kai Chen clocked in' },
  { t:'10:20', text:'Inventory restocked: Arabica beans 5kg' },
  { t:'09:58', text:'Order #1040 completed · ฿16.00' },
  { t:'09:40', text:'AI promo applied: Burger + Lemonade −25%' },
];
export function ecoBaht(v: number): string { return `฿${v.toFixed(2)}`; }
