// app/api/create-checkout-session/route.js
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16',
});

export async function POST(req) {
  try {
    const { userId } = auth();
    
    if (!userId) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    // Get user email from request body
    const body = await req.json();
    const { email } = body;

    if (!email) {
      return NextResponse.json(
        { error: 'Email required for checkout' },
        { status: 400 }
      );
    }

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price: 'price_1SAWnjEn5hx21UrBqUPlZt8J',
          quantity: 1,
        },
      ],
      success_url: `https://app.audiograffiti.co?success=true`,
      cancel_url: `https://app.audiograffiti.co?canceled=true`,
      customer_email: email,
      metadata: {
        userId: userId,
        product: 'audiograffiti-pro',
      },
      subscription_data: {
        metadata: {
          userId: userId,
          product: 'audiograffiti-pro',
        },
      },
    });

    return NextResponse.json({ 
      sessionId: session.id,
      url: session.url 
    });

  } catch (error) {
    console.error('Stripe checkout error:', error);
    return NextResponse.json(
      { error: 'Failed to create checkout session' },
      { status: 500 }
    );
  }
}