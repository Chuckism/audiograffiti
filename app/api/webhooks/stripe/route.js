// app/api/webhooks/stripe/route.js
import { NextRequest, NextResponse } from 'next/server';
import { clerkClient } from '@clerk/nextjs/server';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16',
});

export async function POST(req) {
  const body = await req.text();
  const sig = req.headers.get('stripe-signature');

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return NextResponse.json({ error: 'Webhook error' }, { status: 400 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object);
        break;
      
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpdate(event.data.object);
        break;
      
      case 'customer.subscription.deleted':
        await handleSubscriptionCanceled(event.data.object);
        break;
      
      case 'invoice.payment_succeeded':
        await handlePaymentSucceeded(event.data.object);
        break;
      
      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object);
        break;
      
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error('Webhook handler error:', error);
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}

async function handleCheckoutCompleted(session) {
  const userId = session.metadata?.userId;
  
  if (!userId) {
    console.error('No userId in checkout session metadata');
    return;
  }

  try {
    // Update user metadata in Clerk to mark as Pro subscriber
    await clerkClient.users.updateUserMetadata(userId, {
      publicMetadata: {
        subscriptionPlan: 'pro',
        stripeCustomerId: session.customer,
        subscriptionStatus: 'active',
        updatedAt: new Date().toISOString(),
      },
    });

    console.log(`User ${userId} upgraded to Pro plan`);
  } catch (error) {
    console.error('Failed to update user metadata:', error);
  }
}

async function handleSubscriptionUpdate(subscription) {
  const userId = subscription.metadata?.userId;
  
  if (!userId) {
    console.error('No userId in subscription metadata');
    return;
  }

  try {
    const isActive = subscription.status === 'active';
    
    await clerkClient.users.updateUserMetadata(userId, {
      publicMetadata: {
        subscriptionPlan: isActive ? 'pro' : 'free',
        subscriptionStatus: subscription.status,
        stripeCustomerId: subscription.customer,
        subscriptionId: subscription.id,
        updatedAt: new Date().toISOString(),
      },
    });

    console.log(`User ${userId} subscription updated: ${subscription.status}`);
  } catch (error) {
    console.error('Failed to update subscription status:', error);
  }
}

async function handleSubscriptionCanceled(subscription) {
  const userId = subscription.metadata?.userId;
  
  if (!userId) {
    console.error('No userId in subscription metadata');
    return;
  }

  try {
    await clerkClient.users.updateUserMetadata(userId, {
      publicMetadata: {
        subscriptionPlan: 'free',
        subscriptionStatus: 'canceled',
        stripeCustomerId: subscription.customer,
        subscriptionId: subscription.id,
        canceledAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });

    console.log(`User ${userId} subscription canceled`);
  } catch (error) {
    console.error('Failed to handle subscription cancellation:', error);
  }
}

async function handlePaymentSucceeded(invoice) {
  const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
  const userId = subscription.metadata?.userId;
  
  if (!userId) {
    console.error('No userId in payment succeeded event');
    return;
  }

  console.log(`Payment succeeded for user ${userId}: $${invoice.amount_paid / 100}`);
}

async function handlePaymentFailed(invoice) {
  const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
  const userId = subscription.metadata?.userId;
  
  if (!userId) {
    console.error('No userId in payment failed event');
    return;
  }

  console.log(`Payment failed for user ${userId}: $${invoice.amount_due / 100}`);
}