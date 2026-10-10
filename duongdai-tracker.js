/**
 * =========================================================================
 * ĐƯƠNG ĐẠI - E-COMMERCE REAL-TIME TRACKER & BRIDGE SCRIPT
 * Website Bán Hàng: https://thanhcuong2k6-sketch.github.io/DUONGDAI/
 * =========================================================================
 * HƯỚNG DẪN TÍCH HỢP:
 * Chèn thẻ sau vào cuối file index.html của web DUONGDAI (trước thẻ </body>):
 * <script src="./duongdai-tracker.js"></script>
 * =========================================================================
 */

(function (window, document) {
  'use strict';

  // Cấu hình Kênh Đồng Bộ Real-time (BroadcastChannel + LocalStorage fallback)
  const CHANNEL_NAME = 'DUONGDAI_ECOMMERCE_REALTIME_BUS';
  const STORAGE_KEY = 'DUONGDAI_HEADLESS_CMS_DATA_V2';
  const ABANDONED_KEY = 'DUONGDAI_CLIENT_CART_SESSION';

  let channel = null;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(CHANNEL_NAME);
    }
  } catch (e) {
    console.warn('[DD-Tracker] BroadcastChannel not supported, using StorageEvent fallback');
  }

  // Khởi tạo đối tượng toàn cục DuongDaiTracker
  const DuongDaiTracker = {
    sessionId: 'sess_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
    trafficSource: detectTrafficSource(),
    cart: loadLocalCart(),

    // Cấu hình BaaS (Firebase Firestore / Supabase) không tốn phí duy trì
    baasConfig: {
      provider: 'local', // 'firebase' | 'supabase' | 'local'
      firebase: null,    // { apiKey, authDomain, projectId, ... }
      supabase: null     // { url, anonKey }
    },

    // 1. GỬI EVENT VỀ ADMIN THEO REAL-TIME
    sendEvent: function (eventType, payload) {
      const eventData = {
        type: eventType,
        sessionId: this.sessionId,
        trafficSource: this.trafficSource,
        timestamp: new Date().toISOString(),
        payload: payload || {}
      };

      console.log(`[DD-Tracker 📡] Event: ${eventType}`, eventData);

      // A. Phát qua WebSocket / BroadcastChannel (cho tab CMS mở cùng trình duyệt)
      if (channel) {
        channel.postMessage(eventData);
      }

      // B. Phát qua postMessage nếu web đang được nhúng trong iframe CMS
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'DUONGDAI_CLIENT_EVENT', event: eventData }, '*');
      }

      // C. Lưu nhật ký vào LocalStorage cho CMS đọc
      try {
        const events = JSON.parse(localStorage.getItem('DUONGDAI_RAW_EVENTS') || '[]');
        events.unshift(eventData);
        if (events.length > 200) events.pop();
        localStorage.setItem('DUONGDAI_RAW_EVENTS', JSON.stringify(events));
        localStorage.setItem('DUONGDAI_STOREFRONT_EVENT', JSON.stringify(eventData));
      } catch (err) {}

      // D. Đồng bộ lên Firebase Firestore nếu được cấu hình
      if (this.baasConfig.provider === 'firebase' && window.firebase && window.firebase.firestore) {
        try {
          const db = window.firebase.firestore();
          if (eventType === 'ORDER_CREATED') {
            db.collection('orders').doc(payload.orderId || ('DD-' + Date.now())).set(eventData);
          } else {
            db.collection('events').add(eventData);
          }
        } catch (fbErr) {
          console.warn('[DD-Tracker] Firebase sync error:', fbErr);
        }
      }

      // E. Đồng bộ lên Supabase Database nếu được cấu hình
      if (this.baasConfig.provider === 'supabase' && window.supabase) {
        try {
          if (eventType === 'ORDER_CREATED') {
            window.supabase.from('orders').insert([eventData]);
          } else {
            window.supabase.from('events').insert([eventData]);
          }
        } catch (sbErr) {
          console.warn('[DD-Tracker] Supabase sync error:', sbErr);
        }
      }
    },

    // 2. THEO DÕI LƯỢT CLICK & XEM SẢN PHẨM (Product View)
    trackProductView: function (productId, productName, category, price) {
      this.sendEvent('PRODUCT_VIEW', {
        productId: productId,
        productName: productName,
        category: category,
        price: price,
        url: window.location.href
      });
    },

    // 3. THEO DÕI THÊM VÀO GIỎ HÀNG (Add-to-cart & Abandoned Cart detection)
    trackAddToCart: function (item) {
      // item = { id, name, size, color, price, quantity, image }
      const existing = this.cart.items.find(i => i.id === item.id && i.size === item.size && i.color === item.color);
      if (existing) {
        existing.quantity += (item.quantity || 1);
      } else {
        this.cart.items.push({
          id: item.id,
          name: item.name,
          size: item.size || 'M',
          color: item.color || 'Tiêu chuẩn',
          price: item.price,
          quantity: item.quantity || 1,
          image: item.image || ''
        });
      }
      this.cart.updatedAt = Date.now();
      saveLocalCart(this.cart);

      this.sendEvent('ADD_TO_CART', {
        item: item,
        totalItems: this.cart.items.reduce((s, i) => s + i.quantity, 0),
        cartValue: this.cart.items.reduce((s, i) => s + (i.price * i.quantity), 0)
      });
    },

    // 4. LƯU THÔNG TIN KHÁCH KHI BẮT ĐẦU ĐIỀN ĐƠN (Để cứu giỏ hàng bị bỏ quên)
    saveCustomerContact: function (name, phone, email) {
      this.cart.customer = {
        name: name || this.cart.customer.name,
        phone: phone || this.cart.customer.phone,
        email: email || this.cart.customer.email
      };
      saveLocalCart(this.cart);

      this.sendEvent('CUSTOMER_CONTACT_INPUT', {
        customer: this.cart.customer,
        cartItems: this.cart.items
      });
    },

    // 5. THEO DÕI ĐẶT HÀNG THÀNH CÔNG (Tự động trừ kho & chuyển phễu)
    trackOrderSuccess: function (orderData) {
      // orderData = { orderId, customerName, phone, address, items, total, voucherCode, discount, paymentMethod }
      const finalOrder = {
        orderId: orderData.orderId || ('DD-' + Math.floor(100000 + Math.random() * 900000)),
        createdAt: new Date().toISOString(),
        customer: {
          name: orderData.customerName || this.cart.customer.name || 'Khách vãng lai',
          phone: orderData.phone || this.cart.customer.phone || '',
          email: orderData.email || this.cart.customer.email || '',
          address: orderData.address || 'Giao tại nhà'
        },
        items: orderData.items || this.cart.items,
        totalAmount: orderData.total || this.cart.items.reduce((s, i) => s + (i.price * i.quantity), 0),
        voucherCode: orderData.voucherCode || '',
        discountAmount: orderData.discount || 0,
        trafficSource: this.trafficSource,
        fulfillmentStatus: 'Chờ xác nhận',
        shippingCarrier: '',
        trackingNumber: '',
        isViewedByAdmin: false
      };

      // Bắn sự kiện đơn hàng thành công
      this.sendEvent('ORDER_CREATED', finalOrder);

      // Xóa giỏ hàng hiện tại vì đã chốt đơn
      this.cart = { items: [], customer: {}, updatedAt: Date.now() };
      saveLocalCart(this.cart);

      return finalOrder;
    },

    // 6. THEO DÕI KHÁCH HỦY ĐƠN
    trackOrderCanceled: function (orderId, reason) {
      this.sendEvent('ORDER_CANCELED', {
        orderId: orderId,
        reason: reason || 'Khách thay đổi ý định',
        timestamp: new Date().toISOString()
      });
    },

    // 7. KIỂM TRA MÃ VOUCHER REAL-TIME VỚI CMS
    validateVoucher: function (code, currentSpend) {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { valid: false, message: 'Chưa có dữ liệu khuyến mãi' };
        const data = JSON.parse(raw);
        const voucher = (data.vouchers || []).find(v => v.code.toUpperCase() === code.trim().toUpperCase() && v.status === 'active');

        if (!voucher) {
          return { valid: false, message: 'Mã giảm giá không tồn tại hoặc đã hết hạn.' };
        }
        if (voucher.min_spend && currentSpend < voucher.min_spend) {
          return { 
            valid: false, 
            message: `Mã chỉ áp dụng cho đơn từ ${new Intl.NumberFormat('vi-VN').format(voucher.min_spend)} VNĐ.` 
          };
        }

        let discount = 0;
        if (voucher.type === 'percentage') {
          discount = (currentSpend * voucher.value) / 100;
          if (voucher.max_discount && discount > voucher.max_discount) {
            discount = voucher.max_discount;
          }
        } else {
          discount = voucher.value;
        }

        return {
          valid: true,
          voucher: voucher,
          discountAmount: discount,
          message: `Áp dụng thành công mã ${voucher.code}!`
        };
      } catch (e) {
        return { valid: false, message: 'Lỗi kiểm tra mã' };
      }
    }
  };

  // PHÁT HIỆN NGUỒN TRUY CẬP (UTM / Referrer Detection)
  function detectTrafficSource() {
    const params = new URLSearchParams(window.location.search);
    const utmSource = params.get('utm_source');
    const utmMedium = params.get('utm_medium');
    const utmCampaign = params.get('utm_campaign');

    if (utmSource) {
      let src = utmSource.toLowerCase();
      if (src.includes('fb') || src.includes('facebook')) return 'Facebook Ads';
      if (src.includes('tiktok')) return 'TikTok Ads';
      if (src.includes('zalo')) return 'Zalo Ads';
      if (src.includes('google')) return 'Google Ads';
      return `Chiến dịch (${utmSource})`;
    }

    const ref = document.referrer.toLowerCase();
    if (ref.includes('facebook.com') || ref.includes('fb.com')) return 'Facebook';
    if (ref.includes('tiktok.com')) return 'TikTok';
    if (ref.includes('zalo.me')) return 'Zalo';
    if (ref.includes('google.com') || ref.includes('google.com.vn')) return 'Google Tìm kiếm';
    if (!ref || ref.includes(window.location.hostname)) return 'Truy cập trực tiếp (Direct)';
    return 'Nguồn giới thiệu khác';
  }

  function loadLocalCart() {
    try {
      const saved = localStorage.getItem(ABANDONED_KEY);
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return { items: [], customer: {}, updatedAt: Date.now() };
  }

  function saveLocalCart(cart) {
    try {
      localStorage.setItem(ABANDONED_KEY, JSON.stringify(cart));
    } catch (e) {}
  }

    // 2. Tự động tải data.json và cập nhật giá, ảnh trực tiếp lên website bán hàng
    syncPricesFromCMS: async function () {
      try {
        const res = await fetch('./data.json?t=' + Date.now());
        if (!res.ok) return;
        const data = await res.json();
        if (!data || !data.products) return;

        console.log('[DD-Tracker] ⚡ Đang cập nhật giá & ảnh mới nhất từ Headless CMS...');

        // Cập nhật banner khẩn cấp
        if (data.marketing_banner && data.marketing_banner.is_announcement_active) {
          let topBar = document.getElementById('duongdai-top-announcement');
          if (!topBar) {
            topBar = document.createElement('div');
            topBar.id = 'duongdai-top-announcement';
            topBar.style.cssText = 'background:#854d0e;color:#fefce8;font-size:11px;font-weight:600;text-align:center;padding:7px 14px;position:relative;z-index:9999;';
            document.body.prepend(topBar);
          }
          topBar.innerText = data.marketing_banner.top_announcement;
        }

        // Quét và cập nhật từng sản phẩm trên trang bán hàng
        const allCards = document.querySelectorAll('.product, .product-item, .product-card, .card, div');
        data.products.forEach(prod => {
          const formattedPrice = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(prod.sale_price || prod.original_price);

          allCards.forEach(card => {
            const text = card.innerText || '';
            if (text.includes(prod.name)) {
              // Tìm phần tử hiển thị giá trong thẻ
              const priceEl = card.querySelector('.price, [class*="price"], .sale-price, b, strong, span');
              if (priceEl && (priceEl.innerText.includes('đ') || priceEl.innerText.includes('VNĐ') || /[\d\.\,]{4,}/.test(priceEl.innerText))) {
                priceEl.innerText = formattedPrice;
              }
              // Cập nhật ảnh nếu có
              const imgEl = card.querySelector('img');
              if (imgEl && prod.image && imgEl.src !== prod.image) {
                imgEl.src = prod.image;
              }
            }
          });
        });
        console.log('[DD-Tracker] ✅ Đã cập nhật xong toàn bộ giá & ảnh mới nhất!');
      } catch (e) {
        console.warn('[DD-Tracker] Không thể nạp data.json cục bộ:', e);
      }
    }
  };

  // TỰ ĐỘNG GẮN BỘ LẮNG NGHE SỰ KIỆN TRÊN WEBSITE (Auto-listeners)
  document.addEventListener('DOMContentLoaded', function () {
    // Tự động quét và cập nhật giá mới từ data.json
    DuongDaiTracker.syncPricesFromCMS();

    // 1. Tự động lắng nghe click vào các nút "Chọn Mua" hoặc thẻ sản phẩm
    document.body.addEventListener('click', function (e) {
      const target = e.target.closest('[data-product-id], .product-item, .card, button');
      if (!target) return;

      // Nút Chọn Mua / Thêm giỏ
      if (target.innerText && target.innerText.toLowerCase().includes('chọn mua')) {
        const card = target.closest('[data-product-id], .product-item, .card, div');
        const titleEl = card ? card.querySelector('h3, h4, h2, .title, strong') : null;
        const priceEl = card ? card.querySelector('.price, [class*="price"], span') : null;
        const name = titleEl ? titleEl.innerText.trim() : 'Sản phẩm Đương Đại';
        
        let price = 390000;
        if (priceEl) {
          const m = priceEl.innerText.match(/[\d\.]+/);
          if (m) price = parseInt(m[0].replace(/\./g, '')) || 390000;
        }

        DuongDaiTracker.trackAddToCart({
          id: 'sp-' + Date.now(),
          name: name,
          size: 'M',
          color: 'Đương Đại Standard',
          price: price,
          quantity: 1
        });
      }
    });

    // 2. Gửi tín hiệu Page View ban đầu
    DuongDaiTracker.sendEvent('PAGE_VIEW', {
      title: document.title,
      url: window.location.href,
      trafficSource: DuongDaiTracker.trafficSource
    });
  });

  // Xuất ra window toàn cục
  window.DuongDaiTracker = DuongDaiTracker;
})(window, document);
