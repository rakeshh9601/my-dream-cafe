const express = require('express');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const app = express();
const ENV_PATH = path.join(__dirname, '.env');

if (fs.existsSync(ENV_PATH) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(ENV_PATH);
}

const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));

// ==========================================
// MONGODB CONNECTION & SCHEMAS
// ==========================================
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ MongoDB Database Connected Successfully!'))
    .catch((err) => console.log('❌ MongoDB Connection Error:', err));

// Mongoose-এর _id কে ফ্রন্টএন্ডের জন্য id তে কনভার্ট করার নিয়ম
const schemaOptions = {
    timestamps: true,
    toJSON: {
        virtuals: true,
        transform: (doc, ret) => {
            ret.id = ret._id;
            delete ret._id;
            delete ret.__v;
        }
    }
};

// ডেটাবেস টেবিল (Models) তৈরি
const Reservation = mongoose.model('Reservation', new mongoose.Schema({
    name: String, email: String, phone: String, guests: Number,
    status: { type: String, default: 'pending' },
    date: String, confirmedAt: Date
}, schemaOptions));

const TodaySpecial = mongoose.model('TodaySpecial', new mongoose.Schema({
    name: String, price: Number
}, schemaOptions));

const Menu = mongoose.model('Menu', new mongoose.Schema({
    name: String, category: String, price: Number
}, schemaOptions));

const Review = mongoose.model('Review', new mongoose.Schema({
    name: String, comment: String, rating: Number,
    status: { type: String, default: 'pending' }
}, schemaOptions));
const Order = mongoose.model('Order', new mongoose.Schema({
    orderId: String,
    customerName: String,
    email: String, // <--- এই নতুন লাইনটি যোগ করুন
    tableNumber: String,
    items: Array,
    totalAmount: Number,
    status: { type: String, default: 'Received' }
}, schemaOptions));

// ==========================================
// AUTHENTICATION & LOGIN
// ==========================================
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
        const token = jwt.sign({ user: username }, process.env.JWT_SECRET, { expiresIn: '12h' });
        res.json({ success: true, token });
    } else {
        res.status(401).json({ success: false, message: 'Invalid username or password' });
    }
});

const authenticateAdmin = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
            if (err) return res.status(403).json({ message: 'Session expired.' });
            req.user = user;
            next();
        });
    } else {
        res.status(401).json({ message: 'Unauthorized access.' });
    }
};

const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

class HttpError extends Error {
    constructor(status, message) {
        super(message); this.status = status;
    }
}

// ==========================================
// EMAIL SENDING LOGIC
// ==========================================
function getMailTransporter() {
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: String(process.env.SMTP_SECURE).toLowerCase() === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
}

async function sendConfirmationEmail(reservation) {
    const transporter = getMailTransporter();
    const from = process.env.SMTP_FROM || process.env.SMTP_USER;
    await transporter.sendMail({
        from, to: reservation.email,
        subject: 'Your My Dream Cafe reservation is confirmed',
        html: `<h2 style="color:#B89768">Your reservation is confirmed</h2>
               <p>Hi ${reservation.name},</p>
               <p>Your table reservation for <strong>${reservation.guests}</strong> guest has been confirmed.</p>
               <p><strong>Date & Time:</strong> ${reservation.date}</p>
               <p>We look forward to seeing you!</p>`
    });
}
async function sendBillEmail(order, email) {
    const transporter = getMailTransporter();
    const from = process.env.SMTP_FROM || process.env.SMTP_USER;
    
    // আইটেমগুলো Group করা
    const itemCounts = {};
    order.items.forEach(item => {
        if(itemCounts[item.name]) {
            itemCounts[item.name].qty += 1;
            itemCounts[item.name].price += item.price;
        } else {
            itemCounts[item.name] = { qty: 1, price: item.price };
        }
    });

    let itemsHtml = '';
    for(const [name, data] of Object.entries(itemCounts)) {
        itemsHtml += `<tr>
            <td style="padding: 8px 0; border-bottom: 1px dashed #eee;">${name} <strong style="color:#777; font-size:0.9em;">x ${data.qty}</strong></td>
            <td style="text-align: right; padding: 8px 0; border-bottom: 1px dashed #eee;">₹${data.price}</td>
        </tr>`;
    }

    await transporter.sendMail({
        from, to: email,
        subject: `Your My Dream Cafe Bill - ${order.orderId}`,
        html: `
        <div style="font-family: Arial, sans-serif; max-width: 400px; margin: auto; border: 1px solid #ddd; padding: 20px; border-radius: 5px;">
            <h2 style="text-align: center; color: #B89768; margin-bottom: 5px;">My Dream Cafe</h2>
            <p style="text-align: center; color: #555; margin-top: 0;">123 Mountain View Road, Darjeeling</p>
            <h3 style="text-align: center; color: #28a745;">Payment Successful ✅</h3>
            <hr style="border: 0; border-top: 1px dashed #ccc; margin: 15px 0;">
            <p><strong>Name:</strong> ${order.customerName}<br>
            <strong>Order ID:</strong> ${order.orderId}<br>
            <strong>Table No:</strong> ${order.tableNumber}<br>
            <strong>Date:</strong> ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</p>
            <hr style="border: 0; border-top: 1px dashed #ccc; margin: 15px 0;">
            <table style="width: 100%; border-collapse: collapse;">
                ${itemsHtml}
            </table>
            <hr style="border: 0; border-top: 1px dashed #ccc; margin: 15px 0;">
            <h3 style="text-align: right; margin: 0; color: #333;">Total Paid: ₹${order.totalAmount}</h3>
            <p style="text-align: center; margin-top: 20px; font-size: 0.9em; color: #777;">Thank you for dining with us!</p>
        </div>`
    });
}
// ==========================================
// RESERVATION APIs
// ==========================================
app.post('/api/reserve', asyncHandler(async (req, res) => {
    const { name, email, phone, guests } = req.body;
    const date = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const newRes = await Reservation.create({ name, email, phone, guests, date });
    res.status(201).json({ message: 'Reservation received!', reservation: newRes });
}));

app.get('/api/reservations', authenticateAdmin, asyncHandler(async (req, res) => {
    const data = await Reservation.find().sort({ createdAt: -1 });
    res.json(data);
}));

app.post('/api/reserve/:id/confirm', authenticateAdmin, asyncHandler(async (req, res) => {
    const reservation = await Reservation.findById(req.params.id);
    if (!reservation) throw new HttpError(404, 'Reservation not found.');
    if (reservation.status === 'confirmed') return res.json({ message: 'Already confirmed.' });
    
    await sendConfirmationEmail(reservation);
    reservation.status = 'confirmed';
    reservation.confirmedAt = new Date();
    await reservation.save();
    
    res.json({ message: 'Confirmed and email sent!', reservation });
}));

app.delete('/api/reserve/:id', authenticateAdmin, asyncHandler(async (req, res) => {
    await Reservation.findByIdAndDelete(req.params.id);
    res.json({ message: 'Deleted successfully.' });
}));
app.delete('/api/admin/orders/:id', authenticateAdmin, asyncHandler(async (req, res) => {
    await Order.findByIdAndDelete(req.params.id);
    res.json({ message: 'Order deleted successfully.' });
}));

// ==========================================
// FULL MENU APIs
// ==========================================
app.get('/api/menu', asyncHandler(async (req, res) => {
    res.json(await Menu.find().sort({ createdAt: -1 }));
}));
app.post('/api/menu', authenticateAdmin, asyncHandler(async (req, res) => {
    const item = await Menu.create(req.body);
    res.status(201).json({ message: 'Item added.', item });
}));
app.put('/api/menu/:id', authenticateAdmin, asyncHandler(async (req, res) => {
    const item = await Menu.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json({ message: 'Item updated.', item });
}));
app.delete('/api/menu/:id', authenticateAdmin, asyncHandler(async (req, res) => {
    await Menu.findByIdAndDelete(req.params.id);
    res.json({ message: 'Item deleted.' });
}));

// ==========================================
// TODAY'S SPECIAL APIs
// ==========================================
app.get('/api/today-specials', asyncHandler(async (req, res) => {
    res.json(await TodaySpecial.find().sort({ createdAt: -1 }));
}));
app.post('/api/today-specials', authenticateAdmin, asyncHandler(async (req, res) => {
    const special = await TodaySpecial.create(req.body);
    res.status(201).json({ message: 'Special added.', special });
}));
app.put('/api/today-specials/:id', authenticateAdmin, asyncHandler(async (req, res) => {
    const special = await TodaySpecial.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json({ message: 'Special updated.', special });
}));
app.delete('/api/today-specials/:id', authenticateAdmin, asyncHandler(async (req, res) => {
    await TodaySpecial.findByIdAndDelete(req.params.id);
    res.json({ message: 'Special deleted.' });
}));
app.get('/today-specials.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'today-specials.json'));
});
// ==========================================
// REVIEWS APIs
// ==========================================
app.post('/api/reviews', asyncHandler(async (req, res) => {
    await Review.create(req.body);
    res.status(201).json({ message: 'Review submitted for approval.' });
}));
app.get('/api/reviews/approved', asyncHandler(async (req, res) => {
    res.json(await Review.find({ status: 'approved' }).sort({ createdAt: -1 }));
}));
app.get('/api/admin/reviews', authenticateAdmin, asyncHandler(async (req, res) => {
    res.json(await Review.find().sort({ createdAt: -1 }));
}));
app.put('/api/admin/reviews/:id/approve', authenticateAdmin, asyncHandler(async (req, res) => {
    await Review.findByIdAndUpdate(req.params.id, { status: 'approved' });
    res.json({ message: 'Review approved.' });
}));
app.delete('/api/admin/reviews/:id', authenticateAdmin, asyncHandler(async (req, res) => {
    await Review.findByIdAndDelete(req.params.id);
    res.json({ message: 'Review deleted.' });
}));
// ==========================================
// LIVE TABLE ORDERS APIs
// ==========================================
app.post('/api/orders', asyncHandler(async (req, res) => {
    const { customerName, email, tableNumber, items, totalAmount } = req.body;
    const orderId = 'ORD-' + Math.floor(100000 + Math.random() * 900000); 
    
    const order = await Order.create({ orderId, customerName, email, tableNumber, items, totalAmount });
    
    // ইমেইলে বিল পাঠিয়ে দেওয়া (ব্যাকগ্রাউন্ডে)
    if(email) {
        sendBillEmail(order, email).catch(err => console.log("Email sending failed:", err));
    }

    res.status(201).json({ message: 'Order placed successfully!', order });
}));

app.get('/api/admin/orders', authenticateAdmin, asyncHandler(async (req, res) => {
    res.json(await Order.find().sort({ createdAt: -1 }));
}));

app.put('/api/admin/orders/:id/status', authenticateAdmin, asyncHandler(async (req, res) => {
    await Order.findByIdAndUpdate(req.params.id, { status: req.body.status });
    res.json({ message: 'Order status updated.' });
}));
app.delete('/api/admin/orders/:id', authenticateAdmin, asyncHandler(async (req, res) => {
    await Order.findByIdAndDelete(req.params.id);
    res.json({ message: 'Order deleted successfully.' });
}));
// ==========================================
// FRONTEND ROUTES & ERROR HANDLER
// ==========================================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

app.use((error, req, res, next) => {
    const status = error instanceof HttpError ? error.status : 500;
    if(status === 500) console.error(error);
    res.status(status).json({ message: error.message || 'Server Error' });
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});