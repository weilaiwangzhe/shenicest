/*
 * ForceBand FSR 裸机固件 (ATmega328P / Arduino Nano) — v3 闭环版
 * ------------------------------------------------------------------
 * 在 v2（FSR 8ch 采集）基础上新增震动控制，实现「腕带→PC→Nano 震动」闭环：
 *
 *   1. UART 接收中断：收到 '0'/'1'/'2'/'3' 控制震动马达
 *   2. Timer2 Fast PWM 输出到 PD3 (=Arduino D3, OC2B)，驱动震动模块 IN 脚
 *   3. kick-start：先 255 打 80ms 再降到目标档位（消除马达启动死区）
 *   4. 3 秒无命令自动关断（安全看门狗）
 *
 * 震动档位（与 Test2 实测一致）：
 *     '0' = 关      '1' = 弱(80)   '2' = 中(140)   '3' = 强(255)
 *
 * 原有 FSR 8 通道 CSV 输出完全保留（100Hz、250000 baud），
 * 因此本固件 = FSR 采集 + 震动输出 二合一，可单独烧录替代 v2。
 *
 * 串口: 250000 baud, 8N1  (16MHz 时钟下 UBRR=3 零误差)
 * 输出: t_ms,v0,v1,v2,v3,v4,v5,v6,v7  (100Hz)
 * 输入: 单字节命令 '0'..'3'
 */
#define F_CPU 16000000UL
#define BAUD  250000UL

#include <stdint.h>
#include <avr/io.h>
#include <avr/interrupt.h>

/* ---------- Timer1 节拍 ---------- */
static volatile uint8_t tick_flag = 0;

ISR(TIMER1_COMPA_vect) {
    tick_flag = 1;
}

/* ---------- UART ---------- */
#define RX_BUF_SIZE 16
static volatile uint8_t rx_buf[RX_BUF_SIZE];
static volatile uint8_t rx_head = 0, rx_tail = 0;

ISR(USART_RX_vect) {
    uint8_t c = UDR0;
    uint8_t next = (uint8_t)((rx_head + 1) & (RX_BUF_SIZE - 1));
    if (next != rx_tail) {          /* 未满才写 */
        rx_buf[rx_head] = c;
        rx_head = next;
    }
}

static void uart_init(void) {
    uint16_t ubrr = (uint16_t)((F_CPU / 16UL / BAUD) - 1UL);
    UBRR0H = (uint8_t)(ubrr >> 8);
    UBRR0L = (uint8_t)(ubrr & 0xFF);
    UCSR0B = (1 << TXEN0) | (1 << RXEN0) | (1 << RXCIE0);   /* 收发 + RX 中断 */
    UCSR0C = (1 << UCSZ01) | (1 << UCSZ00);                 /* 8N1 */
}

static void uart_putc(char c) {
    while (!(UCSR0A & (1 << UDRE0))) { ; }
    UDR0 = c;
}

static void uart_puts(const char *s) {
    while (*s) uart_putc(*s++);
}

static void uart_put_u16(uint16_t v) {
    char buf[6];
    char *p = buf + 5;
    *p = '\0';
    do { *--p = (char)('0' + (v % 10)); v /= 10; } while (v);
    uart_puts(p);
}

static void uart_put_u32(uint32_t v) {
    char buf[11];
    char *p = buf + 10;
    *p = '\0';
    do { *--p = (char)('0' + (v % 10)); v /= 10; } while (v);
    uart_puts(p);
}

/* ---------- ADC ---------- */
/* 切换通道后 dummy 读一次（丢弃），让保持电容充分建立，再读真实值 */
static uint16_t adc_read(uint8_t ch) {
    ADMUX = (1 << REFS0) | (ch & 0x07);       /* AVcc 参考, 选通道 0-7 */
    ADCSRA = (1 << ADEN) | (1 << ADSC)
           | (1 << ADPS2) | (1 << ADPS1) | (1 << ADPS0);
    while (ADCSRA & (1 << ADSC)) { ; }
    ADCSRA |= (1 << ADSC);
    while (ADCSRA & (1 << ADSC)) { ; }
    return ADC;
}

/* ---------- 震动控制 (Timer2 PWM, OC2B = PD3 = D3) ---------- */
static volatile uint8_t  vib_target = 0;   /* 目标 PWM：0/80/140/255 */
static volatile uint8_t  vib_kick   = 0;   /* kick-start 剩余节拍 */
static volatile uint16_t vib_idle   = 0;   /* 距上次命令的节拍数（看门狗） */

static void vib_init(void) {
    DDRD |= (1 << DDD3);                                  /* PD3 输出 */
    TCCR2A = (1 << COM2B1) | (1 << WGM21) | (1 << WGM20); /* Fast PWM, OC2B 非反相 */
    TCCR2B = (1 << CS22);                                 /* 64 分频 → 976.6 Hz */
    OCR2B  = 0;
}

static void vib_set(uint8_t pwm) {
    vib_idle = 0;
    if (pwm == 0) {
        vib_target = 0;
        vib_kick   = 0;
        OCR2B = 0;
        return;
    }
    vib_target = pwm;
    OCR2B = 255;        /* kick-start：先满占空比打一下 */
    vib_kick = 8;       /* 8 × 10ms = 80ms 后降到目标档位 */
}

/* 每 10ms 节拍调用一次 */
static void vib_tick(void) {
    if (vib_kick > 0) {
        vib_kick--;
        if (vib_kick == 0) {
            OCR2B = vib_target;
        }
    }
    if (vib_target != 0) {
        vib_idle++;
        if (vib_idle >= 300) {   /* 3 秒无命令 → 安全关断 */
            vib_target = 0;
            vib_kick   = 0;
            OCR2B = 0;
        }
    }
}

static void vib_cmd(uint8_t c) {
    switch (c) {
        case '0': vib_set(0);   break;
        case '1': vib_set(80);  break;
        case '2': vib_set(140); break;
        case '3': vib_set(255); break;
        default:  break;
    }
}

/* ---------- main ---------- */
int main(void) {
    uint32_t tick = 0;
    uint16_t v[8];
    uint8_t i;

    uart_init();
    vib_init();

    /* Timer1: CTC 模式, 64 分频, OCR1A=2499 → 10.000ms 精确中断 */
    TCCR1A = 0;
    TCCR1B = (1 << WGM12) | (1 << CS11) | (1 << CS10);
    OCR1A = 2499;
    TIMSK1 = (1 << OCIE1A);
    sei();

    (void)adc_read(0);

    uart_puts("# FSR 8ch v3 + 震动(D3) @250000\r\n");

    for (;;) {
        while (!tick_flag) { ; }
        tick_flag = 0;

        /* 处理串口命令 */
        while (rx_tail != rx_head) {
            uint8_t c = rx_buf[rx_tail];
            rx_tail = (uint8_t)((rx_tail + 1) & (RX_BUF_SIZE - 1));
            vib_cmd(c);
        }

        vib_tick();

        for (i = 0; i < 8; i++) v[i] = adc_read(i);
        uart_put_u32(tick * 10UL);
        for (i = 0; i < 8; i++) {
            uart_putc(',');
            uart_put_u16(v[i]);
        }
        uart_puts("\r\n");
        tick++;
    }
}
