const menuGroups = [
  { id:'espresso', category:'coffee', title:'Espresso Bar', note:'100% Arabica Lâm Đồng · Honey process', items:[
    ['Single | Double Espresso','40 | 50','',false],['Americano','45','',false],['Cappuccino','65','',false],['Latte','65','',false],['Bana Latte','65','',false],['Oat Milk Latte','75','',false],['An-Giang','70','Espresso, kem sữa mịn, thốt nốt ngào đường.',true],['Amecoco','—','Nước dừa tươi và 1 shot espresso.',true]
  ]},
  { id:'coldbrew', category:'coffee', title:'Cold Brew', note:'Ủ lạnh · trong trẻo · nhiều lớp vị', items:[
    ['No. 01 (S | L — bottle)','60 | 75','Cà phê ủ lạnh.',false],['No. 02 (S | L — bottle)','70 | 85','Cà phê ủ lạnh với sữa.',false],['Grapefruit Rush','70','Cà phê ủ lạnh, nước ép bưởi, chanh vàng.',true],['Sunset Brew','70','Cà phê ủ lạnh, nước ép thanh mai, chanh vàng.',true],['Tây-Bắc','70','Cà phê ủ lạnh, nước cam tươi, mắc khén.',true],['Coco Brew','70','Cà phê ủ lạnh, nước dừa tươi.',false],['Ruby Pome','70','Cà phê ủ lạnh, nước ép lựu.',true]
  ]},
  { id:'vietnamese', category:'coffee', title:'Vietnamese Coffee', note:'Robusta · vị quen theo cách của The Comma', items:[
    ['Caffè Đen','40','',false],['Caffè Sữa','45','',false],['Caffè Sữa Tươi','50','',false],['Bạc Xỉu','50','',false],['“Tào Phớ”','65','Singleshot Robusta, sữa tươi, topping tàu hũ.',true],['Caffè Hoa Muối','65','Doubleshot Robusta, sữa đặc, foam béo.',true]
  ]},
  { id:'handbrew-menu', category:'coffee', title:'Single Origin / Hand Brew', note:'Seasonal selected', items:[
    ['Pick Bean + Pick Method','80','Chọn hạt theo mùa và phương pháp V60, AeroPress hoặc Kalita Wave.',false]
  ]},
  { id:'tea', category:'tea', title:'Tea & Chocolate', note:'Hoa · trái cây · những lớp vị dịu', items:[
    ['Trà Sữa Hoa Mộc Tê','65','Trà sữa ô long hoa mộc tê, tàu hũ nhà làm.',false],['Floral Bliss','65','Trà lê hoa cúc, milk foam.',false],['Mê Mơ','65','Trà đen, trái mơ ngâm.',false],['Lài Thơm Xí Muội','65','Trà xanh lài, mứt thơm, xí muội.',false],['Mango Tango','65','Trà xanh, xoài, xí muội.',false],['Le-Chi Princess','65','Trà đen, cam, vải hoa hồng.',false],['Bloody Pome','65','Trà xanh lài, nước ép lựu, chanh vàng.',true],['Blush Whisper','65','Trà xanh, nước ép thanh mai, chanh vàng.',true],['Summer Kiss','65','Trà xanh, nước ép bưởi, chanh vàng.',true],['A Better Day','65','Trà hoa cúc, nụ hoa hồng, kỷ tử, táo tàu, gừng, đường nâu.',false],['A Dreamy Night','65','Trà kim ngân hoa, cúc trắng, kỷ tử, hạt muồng, quế hoa, ngưu bàng.',false],['Chocolate','65','',false],['Choco Kem Nhãn','65','Chocolate với kem nhãn.',false]
  ]},
  { id:'matcha', category:'matcha', title:'Matcha', note:'Bột trà xanh Nhật Bản', items:[
    ['Matcha Latte','65','Matcha, sữa tươi, sữa đặc.',false],['Coco Matcha','65','Matcha, nước dừa tươi.',false],['Cochy Bloom','65','Matcha, vải hoa hồng, nước dừa.',false],['Sunny Matcha','65','Matcha, sữa tươi, xoài.',false]
  ]},
  { id:'season', category:'season', title:'Season', note:'Theo mùa · có trong thời gian giới hạn', items:[
    ['Trà Quýt','—','Phiên bản trà quýt theo mùa.',true],['Trà Sấu Mắc Khén','—','Phiên bản trà sấu mắc khén theo mùa.',true]
  ]},
  { id:'juice', category:'juice', title:'Juice', note:'Tươi · mát · sáng vị', items:[
    ['Tropicoco','65','Nước dừa tươi, nước ép thơm, mứt dâu, đá lá nếp.',false],['Cam Mật Ong','55','',false]
  ]}
];

const grid = document.querySelector('#menu-grid');
const filters = [...document.querySelectorAll('.menu-filter')];

function renderMenu(filter='coffee'){
  const selected = filter === 'all' ? menuGroups : menuGroups.filter(g => g.category === filter);
  grid.innerHTML = selected.map(group => `
    <section class="menu-group" data-category="${group.category}">
      <header class="menu-group-title"><h3>${group.title}</h3><span>${group.note}</span></header>
      ${group.items.map(([name,price,desc,featured]) => `
        <article class="menu-item${featured?' featured':''}">
          <h4>${name}</h4><span class="price">${price}</span>
          ${featured?'<span class="drop-icons">●</span>':''}
          ${desc?`<p>${desc}</p>`:''}
        </article>`).join('')}
    </section>`).join('');
}

filters.forEach(button => button.addEventListener('click', () => {
  filters.forEach(b => b.classList.remove('active'));
  button.classList.add('active');
  renderMenu(button.dataset.filter);
  document.querySelector('#menu-grid').scrollIntoView({behavior:'smooth',block:'start'});
}));
renderMenu();

const slides=[...document.querySelectorAll('.hero-slide')];
const currentEl=document.querySelector('.hero-counter b');
let current=0, timer;
function showSlide(index){
  current=(index+slides.length)%slides.length;
  slides.forEach((s,i)=>s.classList.toggle('active',i===current));
  currentEl.textContent=String(current+1).padStart(2,'0');
}
function autoplay(){clearInterval(timer);timer=setInterval(()=>showSlide(current+1),6500)}
document.querySelector('.hero-next').addEventListener('click',()=>{showSlide(current+1);autoplay()});
document.querySelector('.hero-prev').addEventListener('click',()=>{showSlide(current-1);autoplay()});
autoplay();

const panel=document.querySelector('.brand-panel');
const backdrop=document.querySelector('.panel-backdrop');
const toggle=document.querySelector('.menu-toggle');
const closeBtn=document.querySelector('.panel-close');
function setPanel(open){
  panel.classList.toggle('active',open);backdrop.classList.toggle('active',open);
  document.body.classList.toggle('panel-open',open);toggle.setAttribute('aria-expanded',String(open));panel.setAttribute('aria-hidden',String(!open));
}
toggle.addEventListener('click',()=>setPanel(true));closeBtn.addEventListener('click',()=>setPanel(false));backdrop.addEventListener('click',()=>setPanel(false));
panel.querySelectorAll('a[href^="#"]').forEach(a=>a.addEventListener('click',()=>setPanel(false)));
document.addEventListener('keydown',e=>{if(e.key==='Escape')setPanel(false)});

const nav=document.querySelector('.site-nav');
window.addEventListener('scroll',()=>nav.classList.toggle('is-scrolled',window.scrollY>50),{passive:true});

window.addEventListener('load',()=>setTimeout(()=>document.querySelector('.preloader').classList.add('done'),500));
setTimeout(()=>document.querySelector('.preloader').classList.add('done'),2500);
