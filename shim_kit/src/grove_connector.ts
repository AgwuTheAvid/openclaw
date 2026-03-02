import axios from 'axios';

// Forward WhatsApp message to Python Brain
export async function sendToGrove(user: string, text: string) {
    try {
        const response = await axios.post('http://localhost:8000/grove/input', {
            user_id: user,
            text: text
        });
        return response.data.reply; // Return The Avid's voice
    } catch (error) {
        console.error("Grove Brain Offline");
        return "Connection Weak. Storing locally.";
    }
}
